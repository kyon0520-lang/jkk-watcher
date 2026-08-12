#!/usr/bin/env node
/**
 * JKK物件監視（セッション使い回し版・1回分の処理）
 *
 * ローカル実行: node --env-file=.env watcher.js [物件名キーワード...]
 *
 * 必須環境変数: JKK_EMAIL / JKK_PASSWORD / NTFY_TOPIC
 * 任意: KEYWORDS, DATA_DIR, PUPPETEER_EXECUTABLE_PATH
 *
 * 通知ロジック: 「前回スキャンには無く、今回現れた物件」を新着とする（差分方式）。
 * これにより、いったん消えて再掲載されたキャンセル分も確実に検知できる。
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const SNAPSHOT_FILE = path.join(DATA_DIR, 'last_snapshot.json');
const HEARTBEAT_FILE = path.join(DATA_DIR, 'heartbeat.json');
const APPLIED_FILE = path.join(DATA_DIR, 'last_applied.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const COND_URL = 'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit';
const MENU_URL = 'https://jhomes.to-kousya.or.jp/search/jkknet/service/mypageMenu';
const SESSION_MAX_MS = 2 * 60 * 60 * 1000; // ブラウザは2時間で作り直す（メモリリーク対策）

function csv(v) { return v ? v.split(',').map(s => s.trim()).filter(Boolean) : []; }
function num(v) { const n = parseInt((v || '').replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : null; }
// 全角→半角（英数記号）。例: ２ＤＫ → 2DK
function toHalf(s) {
  return (s || '').replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).toUpperCase();
}
// 家賃文字列の下限（最安）を数値で。"206,800～233,400" → 206800
function rentLow(s) { return num((s || '').split(/[~～〜]/)[0]); }
// 床面積の上限（最広）を数値で。"45.7～50.17" → 50.17
function areaHigh(s) {
  const parts = (s || '').split(/[~～〜]/);
  const f = parseFloat(parts[parts.length - 1]);
  return Number.isFinite(f) ? f : null;
}

const CONFIG = {
  email: process.env.JKK_EMAIL,
  password: process.env.JKK_PASSWORD,
  ntfyTopic: process.env.NTFY_TOPIC || 'jkk-watch',
  keywords: csv(process.env.KEYWORDS),                 // 物件名 or エリアの部分一致
  layouts: csv(process.env.LAYOUTS).map(toHalf),       // 間取り（例: 2DK,3DK,2LDK）
  maxRent: num(process.env.MAX_RENT),                  // 家賃上限（円）
  minArea: parseFloat(process.env.MIN_AREA) || null,   // 床面積下限（㎡）

  // --- 検証モード（子育て優先など特定の新着でドライラン申込を1回だけ実行し挙動記録）---
  validateTarget: (process.env.VALIDATE_TARGET || '').trim(),            // 物件名/優先種別/エリアの部分一致。空=OFF

  // --- 自動申込（B-2 事前武装型）---
  autoApplyTarget: (process.env.AUTO_APPLY_TARGET || '').trim(),         // 物件名。空=OFF
  autoApplyLive: (process.env.AUTO_APPLY_LIVE || '').toLowerCase() === 'yes', // yesで本番申込。既定はドライラン
  applyLayouts: csv(process.env.APPLY_LAYOUTS).map(toHalf),              // 申込対象の間取り限定（任意）
  applyMaxRent: num(process.env.APPLY_MAX_RENT),                         // 申込対象の家賃上限（任意）
  applyOrient: csv(process.env.APPLY_ORIENT),                            // 向きの優先順（例: 南,東）。先頭ほど優先。空=不問
  applyOrientStrict: (process.env.APPLY_ORIENT_STRICT || '').toLowerCase() !== 'no', // 既定: リスト外の向きには申し込まない
  apply: {                                                              // 申込内容入力(mskInput)の定型回答
    yusen: process.env.APPLY_YUSEN || '0010',     // 優先応募資格（満18歳未満の子と同居=0010）
    jukyo: process.env.APPLY_JUKYO || '0001',     // 現在の住居(本人) 民間賃貸住宅=0001
    syoyusya: process.env.APPLY_SYOYUSYA || '',   // 所有者/名義人（個人情報→secretで設定。未設定なら申込中止）
    chusyajo: process.env.APPLY_CHUSYAJO || '2',  // 駐車場 希望する(空きなければ住宅のみ)=2
    hojin: process.env.APPLY_HOJIN || '0',        // 借上社宅 利用しない=0
    share: process.env.APPLY_SHARE || '0',        // ルームシェア 利用しない=0
    hosho: process.env.APPLY_HOSHO || '3',        // 保証会社 オリコフォレントインシュア=3
    shiokuri: process.env.APPLY_SHIOKURI || '',   // 仕送り金額（空）
  },
};

// 自動申込の対象部屋条件（間取り・家賃）を満たすか
function matchesApplyCriteria(p) {
  if (CONFIG.applyLayouts.length && !CONFIG.applyLayouts.includes(toHalf(p.layout))) return false;
  if (CONFIG.applyMaxRent != null) { const r = rentLow(p.rent); if (r == null || r > CONFIG.applyMaxRent) return false; }
  return true;
}

// 二重申込防止（同じターゲットには一度だけ）
function alreadyApplied(target) {
  try { if (fs.existsSync(APPLIED_FILE)) return JSON.parse(fs.readFileSync(APPLIED_FILE, 'utf8')).target === target; } catch (e) {}
  return false;
}
function markApplied(target) {
  try { fs.writeFileSync(APPLIED_FILE, JSON.stringify({ target, ts: new Date().toISOString() })); } catch (e) {}
}

// 検証の一度きり実行（VALIDATE_TARGETが変われば再検証可）
const VALIDATED_FILE = path.join(DATA_DIR, 'validated.json');
function alreadyValidated() {
  try { if (fs.existsSync(VALIDATED_FILE)) return JSON.parse(fs.readFileSync(VALIDATED_FILE, 'utf8')).target === CONFIG.validateTarget; } catch (e) {}
  return false;
}
function markValidated(name) {
  try { fs.writeFileSync(VALIDATED_FILE, JSON.stringify({ target: CONFIG.validateTarget, name, ts: new Date().toISOString() })); } catch (e) {}
}

// 全フィルターを満たすか（各種別はAND、種別内はOR）
function matchesFilters(p) {
  if (CONFIG.keywords.length && !CONFIG.keywords.some(k => p.name.includes(k) || p.area.includes(k))) return false;
  if (CONFIG.layouts.length && !CONFIG.layouts.includes(toHalf(p.layout))) return false;
  if (CONFIG.maxRent != null) { const r = rentLow(p.rent); if (r == null || r > CONFIG.maxRent) return false; }
  if (CONFIG.minArea != null) { const a = areaHigh(p.floorArea); if (a == null || a < CONFIG.minArea) return false; }
  return true;
}

// ---- 通知 ----
function sendNotification(title, body, url) {
  return new Promise((resolve) => {
    const data = Buffer.from(body, 'utf8');
    const req = https.request({
      hostname: 'ntfy.sh',
      path: `/${CONFIG.ntfyTopic}`,
      method: 'POST',
      headers: {
        // HTTPヘッダーはASCIIのみ。UTF-8バイト列をlatin1として送る
        'Title': Buffer.from(title, 'utf8').toString('latin1'),
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': data.length,
        ...(url ? { 'Click': url } : {}),
      },
    }, (res) => { console.log(`通知送信: ${res.statusCode}`); resolve(); });
    req.on('error', (e) => { console.error('通知エラー:', e.message); resolve(); });
    req.write(data);
    req.end();
  });
}

// ---- 状態（スナップショット・見張り通知） ----
function loadSnapshot() {
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) return new Set(JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')));
  } catch (e) {}
  return null; // null = まだ一度も記録なし
}
function saveSnapshot(ids) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(ids));
}
function jstDateStr() {
  return new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
}
async function maybeHeartbeat() {
  const today = jstDateStr();
  let last = null;
  try { if (fs.existsSync(HEARTBEAT_FILE)) last = fs.readFileSync(HEARTBEAT_FILE, 'utf8').trim(); } catch (e) {}
  if (last !== today) {
    await sendNotification('✅ JKK監視 稼働中', `本日の監視を開始しました（${today}）。新着が出たら通知します。`, 'https://jhomes.to-kousya.or.jp/');
    try { fs.writeFileSync(HEARTBEAT_FILE, today); } catch (e) {}
    console.log('見張り通知を送信');
  }
}

// ---- ブラウザ／セッション（使い回し） ----
let browser = null;
let lp = null; // ログイン済みの作業ページ
let sessionStartedAt = 0;

function launchOpts() {
  const o = {
    headless: 'new',
    protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--disable-background-networking'],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) o.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  return o;
}

async function resetSession() {
  try { if (browser) await browser.close(); } catch (e) {}
  browser = null; lp = null; sessionStartedAt = 0;
}

async function ensureBrowser() {
  let connected = false;
  try { connected = browser && browser.connected; } catch (e) { connected = false; }
  const tooOld = Date.now() - sessionStartedAt > SESSION_MAX_MS;
  if (connected && tooOld) { console.log('セッション期限超過→作り直し'); await resetSession(); connected = false; }
  if (!connected) {
    browser = await puppeteer.launch(launchOpts());
    lp = null;
    sessionStartedAt = Date.now();
  }
}

// フルログイン → ログイン済みページを返す
async function doLogin() {
  // 余分なタブを閉じる
  const pages = await browser.pages();
  for (const p of pages.slice(1)) { try { await p.close(); } catch (e) {} }
  const page = (await browser.pages())[0];

  await page.goto(MENU_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.evaluate(() => submitNext());
  await new Promise(r => setTimeout(r, 5000));

  const tab = (await browser.pages()).slice(-1)[0];
  // 申込フロー中の確認ダイアログを自動承認（通常スクレイピングでは出ない）
  tab.removeAllListeners('dialog');
  tab.on('dialog', async d => { console.log('【dialog】', d.message()); await d.accept().catch(() => {}); });
  await tab.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  await tab.waitForSelector('input[name="loginRM.loginM.password"]', { timeout: 15000 });
  await tab.type('input[name="loginRM.loginM.userId"]', CONFIG.email, { delay: 50 });
  await tab.type('input[name="loginRM.loginM.password"]', CONFIG.password, { delay: 50 });
  await Promise.all([
    tab.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
    tab.evaluate(() => document.querySelector('a[onclick*="loginPage"]').click()),
  ]);
  console.log('ログイン完了');
  return tab;
}

// ページ遷移レースで evaluate が落ちる（Execution context was destroyed 等）場合に
// 数回リトライする安全版 evaluate。読み取り系に使う。
const TRANSIENT_RE = /context was destroyed|Target closed|detached|Cannot find context|Session closed/i;
async function safeEval(fn, ...args) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try { return await lp.evaluate(fn, ...args); }
    catch (e) { lastErr = e; if (TRANSIENT_RE.test(e.message)) { await sleep(400); continue; } throw e; }
  }
  throw lastErr;
}

// 現在のセッションで検索→取得。ログアウトを検知したら {loggedOut:true} を返す
async function scrapeCurrent() {
  await lp.goto(COND_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  const state = await safeEval(() => ({
    loggedOut: !!document.querySelector('input[name="loginRM.loginM.password"]'),
    hasSubmit: typeof submitPage === 'function',
  }));
  if (state.loggedOut || !state.hasSubmit) return { loggedOut: true };

  await Promise.all([
    lp.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
    safeEval(() => submitPage('akiyaJyoukenRef')),
  ]);
  await sleep(300);
  if (!lp.url().includes('akiyaJyoukenRef')) return { loggedOut: true };

  // 50件表示
  await Promise.all([
    lp.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
    safeEval(() => {
      const sel = document.querySelector('select[name="akiyaRefRM.showCount"]');
      if (sel) { sel.value = '50'; sel.dispatchEvent(new Event('change')); }
    }),
  ]);
  await sleep(300);

  const items = await safeEval(() => {
    const out = [];
    document.querySelectorAll('table tr').forEach((row, i) => {
      if (i === 0) return;
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) return;
      const name = cells[1]?.innerText?.trim() || '';
      if (!name || name.includes('住宅名') || name.includes('件が該当') || name.includes('住宅外観')) return;
      const area = cells[2]?.innerText?.trim() || '';
      const yusen = cells[3]?.innerText?.trim() || '';   // 優先種別（子育・高齢 等）
      const layout = cells[5]?.innerText?.trim() || '';
      const floorArea = cells[6]?.innerText?.trim() || '';
      const rent = cells[7]?.innerText?.trim() || '';
      const url = row.querySelector('a')?.href || '';
      out.push({ id: `${name}|${layout}|${floorArea}|${rent}`, name, area, yusen, layout, floorArea, rent, url });
    });
    return out;
  });
  return { items };
}

// scrapeCurrent を遷移レースのエラーに強くする（1回リトライ）
async function scrapeCurrentSafe() {
  try { return await scrapeCurrent(); }
  catch (e) {
    if (TRANSIENT_RE.test(e.message)) { console.log('スクレイプ一時エラー→リトライ:', e.message); await sleep(800); return await scrapeCurrent(); }
    throw e;
  }
}

// ログイン維持で取得。切れていたら1回だけ再ログインしてリトライ
async function fetchProperties() {
  await ensureBrowser();
  if (!lp || lp.isClosed()) lp = await doLogin();

  let res = await scrapeCurrentSafe();
  if (res.loggedOut) {
    console.log('セッション切れを検知→再ログイン');
    lp = await doLogin();
    res = await scrapeCurrentSafe();
    if (res.loggedOut) throw new Error('再ログイン後もログアウト状態');
  }
  console.log(`取得: ${res.items.length}件`);
  return res.items;
}

// クリック→遷移待ち（遷移レースで evaluate が落ちたらリトライ）
async function navClick(fn, ...args) {
  await Promise.all([lp.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}), safeEval(fn, ...args)]);
  await sleep(1200);
}

// 自動申込（結果ページ表示中の lp を使う）。本番フラグOFFなら最終確認の直前で止める。
async function autoApply(p, opts = {}) {
  const A = CONFIG.apply;
  const live = opts.forceDryRun ? false : CONFIG.autoApplyLive;
  const tag = opts.label || (live ? '本番' : 'ドライラン');
  console.log(`🤖 自動申込[${tag}] 開始: ${p.name} [${p.yusen || '一般'}] ${p.layout} ${p.rent}`);

  // 1. 該当行の senPage をクリック → 詳細
  const clicked = await safeEval((name, layout, rent) => {
    const t = s => (s || '').trim();
    for (const r of Array.from(document.querySelectorAll('table tr'))) {
      const td = r.querySelectorAll('td');
      if (td.length < 8) continue;
      if (t(td[1].innerText) === name && t(td[5].innerText) === layout && t(td[7].innerText) === rent) {
        const a = r.querySelector('a[onclick*="senPage"]');
        if (a) { a.click(); return true; }
      }
    }
    return false;
  }, p.name, p.layout, p.rent);
  if (!clicked) throw new Error('該当行(senPage)が見つからない');
  await lp.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  await sleep(1500);
  if (!lp.url().includes('akiyaSenDet')) throw new Error('詳細へ遷移せず: ' + lp.url());

  // 2. 号室を選ぶ（向き優先）→ 申込ボタン submitMsk(index)
  const rooms = await safeEval(() => {
    return Array.from(document.querySelectorAll('[onclick*="submitMsk"]')).map(e => {
      const m = (e.getAttribute('onclick') || '').match(/submitMsk\((\d+)\)/);
      const row = e.closest('tr');
      const c = row ? Array.from(row.querySelectorAll('td')).map(td => td.innerText.replace(/\s+/g, ' ').trim()) : [];
      // 向きは「南」「南西」等、東西南北のみで構成される短いセル＝位置に依存せず特定できる
      const orient = c.find(x => /^[東西南北]{1,2}$/.test(x)) || '';
      const room = c.find(x => /^[0-9A-Za-z]+[-‐]\d+$/.test(x)) || c[1] || '';
      const li = c.findIndex(x => /^[0-9０-９]+[ＬＤＫＳLDKS]{1,4}$/.test(x));
      const layout = li >= 0 ? c[li] : (c[4] || '');
      const rent = (li >= 0 ? c.slice(li + 1) : c).find(x => /^[\d,]{4,}$/.test(x)) || '';
      return { idx: m ? parseInt(m[1], 10) : null, room, layout, orient, rent };
    }).filter(r => r.idx !== null);
  });
  if (!rooms || !rooms.length) throw new Error('申込可能な号室が見つからない');
  console.log('🏠 号室一覧:', rooms.map(r => `${r.room}[${r.orient || '向き不明'}] ${r.layout} ${r.rent}`).join(' | '));

  // 間取り・家賃で候補を絞る
  let cands = rooms;
  if (CONFIG.applyLayouts.length) cands = cands.filter(r => !r.layout || CONFIG.applyLayouts.includes(toHalf(r.layout)));
  if (CONFIG.applyMaxRent != null) cands = cands.filter(r => { const v = rentLow(r.rent); return v == null || v <= CONFIG.applyMaxRent; });
  if (!cands.length) throw new Error(`条件に合う号室なし（${rooms.map(r => r.room + ':' + r.layout).join(',')}）`);

  // 向きの優先順で選ぶ
  let chosen = cands[0];
  if (CONFIG.applyOrient.length) {
    let hit = null;
    for (const o of CONFIG.applyOrient) { const f = cands.find(r => r.orient && r.orient.includes(o)); if (f) { hit = f; break; } }
    if (hit) chosen = hit;
    else if (CONFIG.applyOrientStrict) throw new Error(`希望の向き[${CONFIG.applyOrient.join('>')}]の号室なし（実際: ${cands.map(r => r.room + ':' + (r.orient || '?')).join(', ')}）`);
    else console.log('⚠️ 希望の向きなし→先頭の号室で続行');
  }
  console.log(`✅ 申込号室: ${chosen.room} [${chosen.orient || '向き不明'}] ${chosen.layout} ${chosen.rent}円 (submitMsk(${chosen.idx}))`);
  p._room = chosen;

  await navClick((i) => submitMsk(i), chosen.idx);
  if (!/mskInit/.test(lp.url())) throw new Error('資格確認へ遷移せず: ' + lp.url());

  // 3. ① 資格確認ページ。優先物件は資格プルダウンを lp.select で選択 → submitPage() を直接呼ぶ
  //    （前回の敗因: 非表示の同意ボタンを .click() しても効かず。関数直呼びが正解）
  const selName = await safeEval(() => { const s = document.querySelector('select[name*="yusenObo"]'); return s ? s.name : null; });
  if (selName) {
    try { await lp.select(`select[name="${selName}"]`, A.yusen); console.log('優先資格を選択:', A.yusen); }
    catch (e) { console.log('資格select失敗:', e.message); }
    await sleep(500);
  }
  await navClick(() => {
    if (typeof submitPage === 'function') { submitPage(); return; }
    const a = Array.from(document.querySelectorAll('a[onclick]')).find(x => /submitPage/.test(x.getAttribute('onclick') || '') && !/showMsg/.test(x.getAttribute('onclick') || ''));
    if (a) a.click();
  });

  // 4-5. 確認/入力ページを汎用的にたどる（一般/優先でページ・関数が違うため、各ページで前進ボタンを自動判別）
  if (!A.syoyusya) throw new Error('APPLY_SYOYUSYA(所有者/名義人)未設定のため中止');
  let reachedFinal = false;
  for (let step = 0; step < 8; step++) {
    const st = await safeEval(() => ({
      url: location.href,
      hasCommit: !!document.querySelector('img[alt*="同意して申し込む"]') || /同意して申し?込む/.test(document.body.innerText),
      isInput: /mskInput/.test(location.href) && !!document.querySelector('[name*="mskInputM"]'),
    }));
    if (st.hasCommit) { reachedFinal = true; break; }

    // 申込内容入力ページなら定型回答を入力
    if (st.isInput) {
      await safeEval((a) => {
        const sel = (n, v) => { const e = document.querySelector(`select[name="${n}"]`); if (e) { e.value = v; e.dispatchEvent(new Event('change')); } };
        const txt = (n, v) => { const e = document.querySelector(`[name="${n}"]`); if (e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA')) e.value = v; };
        const rad = (n, v) => { const e = document.querySelector(`input[name="${n}"][value="${v}"]`); if (e) e.checked = true; };
        sel('mskInputRM.mskInputM.jukyoCdH', a.jukyo);
        txt('mskInputRM.mskInputM.syoyusya', a.syoyusya);
        rad('mskInputRM.mskInputM.chusyajoFlg', a.chusyajo);
        rad('mskInputRM.mskInputM.hojinFlg', a.hojin);
        rad('mskInputRM.mskInputM.shareFlg', a.share);
        rad('mskInputRM.mskInputM.hoshoFlg', a.hosho);
        txt('mskInputRM.mskInputM.shiokuriMoney', a.shiokuri);
      }, A);
    }

    // 前進ボタンを優先順位で判別して押す（確定・戻る・編集リンク等は除外）
    const before = lp.url();
    const fwd = await safeEval(() => {
      const bad = /同意して申し?込む|戻る|キャンセル|再検索|ユーザ情報|マイページ|ログアウト|申込審査情報の確認|showMsg|openHelp|openShikaku|Home|Logout|Bak|再検索/i;
      const cands = Array.from(document.querySelectorAll('a[onclick],input[type=image],input[type=button],input[type=submit],button'))
        .map(e => ({ el: e, label: (e.value || e.innerText || e.alt || (e.querySelector('img') ? e.querySelector('img').alt : '') || '').trim(), oc: e.getAttribute('onclick') || '' }))
        .filter(c => (c.label || c.oc) && !bad.test(c.label) && !bad.test(c.oc));
      const prio = [/申込内容入力/, /内容確認/, /確認して申込/, /次へ/, /申込む/, /進む/, /^同意する$/, /確認/];
      for (const re of prio) { const f = cands.find(c => re.test(c.label)); if (f) { f.el.click(); return f.label; } }
      const f2 = cands.find(c => /msk(Input|Confirm)|submitPage|shikaku/i.test(c.oc));
      if (f2) { f2.el.click(); return f2.label || f2.oc; }
      // 前進不明: 候補ラベルを返して知らせる
      return 'NONE:' + cands.map(c => c.label || c.oc.slice(0, 20)).slice(0, 8).join(' / ');
    });
    if (fwd.startsWith('NONE:')) throw new Error(`前進ボタン不明 [${st.url.split('/').pop()}] 候補=${fwd.slice(5)}`);
    console.log(`→ 前進(${step}):`, fwd);
    await lp.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    await sleep(1000);
    if (lp.url() === before && !st.isInput) throw new Error(`遷移せず(同ページ) [${lp.url().split('/').pop()}] btn=${fwd}`);
  }
  if (!reachedFinal) throw new Error('最終確認画面に到達せず: ' + lp.url());

  const roomInfo = p._room ? `${p._room.room}号室[${p._room.orient || '向き不明'}]` : '';
  if (!live) {
    console.log('ドライラン: 最終確認画面に到達。確定はしない。');
    await sendNotification('🟡 自動申込ドライラン成功', `${p.name} ${roomInfo} ${p.layout} ${p.rent}円 — 申込直前まで到達（未申込）`, '');
    return { dryrun: true, room: p._room };
  }

  // 本番: 「同意して申し込む」を押す
  const committed = await safeEval(() => {
    const img = document.querySelector('img[alt*="同意して申し込む"]');
    const a = img ? img.closest('a') : null;
    if (a) { a.click(); return true; }
    const el = Array.from(document.querySelectorAll('a,input,button')).find(x => /同意して申し?込む/.test(x.value || x.innerText || x.alt || ''));
    if (el) { el.click(); return true; }
    return false;
  });
  if (!committed) throw new Error('確定ボタンが見つからない');
  await lp.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  await sleep(1500);
  console.log('🎉 申込完了:', p.name, roomInfo, lp.url());
  await sendNotification('✅ JKK申込完了', `${p.name} ${roomInfo} ${p.layout} ${p.rent}円 を自動で申し込みました`, 'https://jhomes.to-kousya.or.jp/');
  return { applied: true, room: p._room };
}

// ---- 1回分 ----
async function runOnce() {
  console.log(`[${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}] JKK監視`);
  if (!CONFIG.email || !CONFIG.password) throw new Error('JKK_EMAIL / JKK_PASSWORD が未設定');

  const f = [];
  if (CONFIG.keywords.length) f.push(`物件名/エリア=[${CONFIG.keywords.join(',')}]`);
  if (CONFIG.layouts.length) f.push(`間取り=[${CONFIG.layouts.join(',')}]`);
  if (CONFIG.maxRent != null) f.push(`家賃≤${CONFIG.maxRent}`);
  if (CONFIG.minArea != null) f.push(`広さ≥${CONFIG.minArea}`);
  console.log(f.length ? `フィルター: ${f.join(' / ')}` : 'フィルター: なし（全物件）');
  if (CONFIG.autoApplyTarget) {
    const cond = [];
    if (CONFIG.applyLayouts.length) cond.push(`間取り=${CONFIG.applyLayouts.join('/')}`);
    if (CONFIG.applyOrient.length) cond.push(`向き優先=${CONFIG.applyOrient.join('>')}${CONFIG.applyOrientStrict ? '(他は申込まない)' : ''}`);
    if (CONFIG.applyMaxRent != null) cond.push(`家賃≤${CONFIG.applyMaxRent}`);
    console.log(`🤖 自動申込: 武装中 [${CONFIG.autoApplyTarget}] モード=${CONFIG.autoApplyLive ? '本番' : 'ドライラン'}${cond.length ? ' / ' + cond.join(' / ') : ''}`);
  }

  await maybeHeartbeat();

  const prev = loadSnapshot();
  const props = await fetchProperties();

  // 異常（0件）はJKK側更新中の可能性。スナップショットを壊さないようスキップ
  if (props.length === 0) { console.log('0件のためスキップ（更新中の可能性）'); return { total: 0, newCount: 0 }; }

  const curIds = props.map(p => p.id);

  if (prev === null) {
    console.log(`初回: 現在の${props.length}件をbaselineとして記録（通知なし）`);
    saveSnapshot(curIds);
    return { total: props.length, newCount: 0 };
  }

  // --- 検証モード（VALIDATE_TARGET）: 該当する子育て優先等の新着で申込フローをドライラン実行し挙動を記録 ---
  if (CONFIG.validateTarget && !alreadyValidated()) {
    const vt = CONFIG.validateTarget;
    const vcand = props.find(p => !prev.has(p.id)
      && `${p.name} ${p.yusen} ${p.area}`.includes(vt)
      && !(CONFIG.autoApplyTarget && p.name.includes(CONFIG.autoApplyTarget))); // 本番ターゲットは除外
    if (vcand) {
      console.log(`🧪 検証(ドライラン)対象: ${vcand.name} [${vcand.yusen}] ${vcand.layout} ${vcand.rent}`);
      try {
        await autoApply(vcand, { forceDryRun: true, label: '検証ドライラン' });
        await sendNotification('🧪 検証ドライラン成功', `${vcand.name} [${vcand.yusen}] ${vcand.layout} — 優先物件の申込フロー最後まで到達（未申込）`, '');
      } catch (e) {
        console.error('🧪 検証エラー:', e.message);
        await sendNotification('🧪 検証ドライラン失敗', `${vcand.name} [${vcand.yusen}]: ${e.message}`, '');
      }
      markValidated(vcand.name);
      await resetSession();
    }
  }

  // --- 自動申込（武装時のみ・最優先で実行）---
  if (CONFIG.autoApplyTarget) {
    const cand = props.find(p => !prev.has(p.id) && p.name.includes(CONFIG.autoApplyTarget) && matchesApplyCriteria(p));
    if (cand) {
      if (alreadyApplied(CONFIG.autoApplyTarget)) {
        console.log(`🤖 自動申込: [${CONFIG.autoApplyTarget}] は申込済み（fire-once）→スキップ`);
      } else {
        // 途中で転んでも即やり直す（最大3回・物件が残っている限り）
        let done = false, lastErr = null;
        for (let attempt = 1; attempt <= 3 && !done; attempt++) {
          try {
            if (attempt > 1) { console.log(`🤖 自動申込リトライ${attempt}`); await fetchProperties(); } // 検索結果ページへ戻す
            const r = await autoApply(cand);
            if (r && r.applied) markApplied(CONFIG.autoApplyTarget); // 本番成功時のみロック
            done = true;
          } catch (e) {
            lastErr = e.message;
            console.error(`🤖 自動申込エラー(試行${attempt}):`, e.message);
            if (/該当行\(senPage\)が見つからない/.test(e.message)) { console.log('→ 物件が消えた（取得済み）ため中止'); break; }
          }
        }
        if (!done) await sendNotification('⚠️ 自動申込エラー', `${cand.name}: ${lastErr}`, '');
        await resetSession(); // 申込フローで遷移したので次回はクリーンに
      }
    }
  }

  const newOnes = props.filter(p => !prev.has(p.id) && matchesFilters(p));

  if (newOnes.length === 0) {
    console.log('新着なし');
  } else {
    console.log(`新着: ${newOnes.length}件`);
    for (const p of newOnes) {
      const title = `🏠 JKK新着: ${p.name}`;
      const body = `${p.area} | ${p.layout} ${p.floorArea}㎡ | ${p.rent}円`;
      console.log(`通知: ${title} — ${body}`);
      await sendNotification(title, body, p.url || 'https://jhomes.to-kousya.or.jp/');
    }
  }

  saveSnapshot(curIds);
  console.log('完了');
  return { total: props.length, newCount: newOnes.length };
}

module.exports = { runOnce, resetSession, fetchProperties, autoApply };

if (require.main === module) {
  if (process.argv.length > 2) CONFIG.keywords = process.argv.slice(2);
  runOnce()
    .then(() => resetSession())
    .catch(async (e) => { console.error('エラー:', e.message); await resetSession(); process.exit(1); });
}
