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

const COND_URL = 'https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyoukenStartInit';
const MENU_URL = 'https://jhomes.to-kousya.or.jp/search/jkknet/service/mypageMenu';
const SESSION_MAX_MS = 2 * 60 * 60 * 1000; // ブラウザは2時間で作り直す（メモリリーク対策）

const CONFIG = {
  email: process.env.JKK_EMAIL,
  password: process.env.JKK_PASSWORD,
  ntfyTopic: process.env.NTFY_TOPIC || 'jkk-watch',
  keywords: process.env.KEYWORDS ? process.env.KEYWORDS.split(',').map(k => k.trim()).filter(Boolean) : [],
};

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

// 現在のセッションで検索→取得。ログアウトを検知したら {loggedOut:true} を返す
async function scrapeCurrent() {
  await lp.goto(COND_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  const state = await lp.evaluate(() => ({
    loggedOut: !!document.querySelector('input[name="loginRM.loginM.password"]'),
    hasSubmit: typeof submitPage === 'function',
  }));
  if (state.loggedOut || !state.hasSubmit) return { loggedOut: true };

  await Promise.all([
    lp.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
    lp.evaluate(() => submitPage('akiyaJyoukenRef')),
  ]);
  if (!lp.url().includes('akiyaJyoukenRef')) return { loggedOut: true };

  // 50件表示
  await Promise.all([
    lp.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
    lp.evaluate(() => {
      const sel = document.querySelector('select[name="akiyaRefRM.showCount"]');
      if (sel) { sel.value = '50'; sel.dispatchEvent(new Event('change')); }
    }),
  ]);

  const items = await lp.evaluate(() => {
    const out = [];
    document.querySelectorAll('table tr').forEach((row, i) => {
      if (i === 0) return;
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) return;
      const name = cells[1]?.innerText?.trim() || '';
      if (!name || name.includes('住宅名') || name.includes('件が該当') || name.includes('住宅外観')) return;
      const area = cells[2]?.innerText?.trim() || '';
      const layout = cells[5]?.innerText?.trim() || '';
      const floorArea = cells[6]?.innerText?.trim() || '';
      const rent = cells[7]?.innerText?.trim() || '';
      const url = row.querySelector('a')?.href || '';
      out.push({ id: `${name}|${layout}|${floorArea}|${rent}`, name, area, layout, floorArea, rent, url });
    });
    return out;
  });
  return { items };
}

// ログイン維持で取得。切れていたら1回だけ再ログインしてリトライ
async function fetchProperties() {
  await ensureBrowser();
  if (!lp || lp.isClosed()) lp = await doLogin();

  let res = await scrapeCurrent();
  if (res.loggedOut) {
    console.log('セッション切れを検知→再ログイン');
    lp = await doLogin();
    res = await scrapeCurrent();
    if (res.loggedOut) throw new Error('再ログイン後もログアウト状態');
  }
  console.log(`取得: ${res.items.length}件`);
  return res.items;
}

// ---- 1回分 ----
async function runOnce() {
  console.log(`[${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}] JKK監視`);
  if (!CONFIG.email || !CONFIG.password) throw new Error('JKK_EMAIL / JKK_PASSWORD が未設定');

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

  const newOnes = props.filter(p => {
    if (prev.has(p.id)) return false;
    if (CONFIG.keywords.length === 0) return true;
    return CONFIG.keywords.some(kw => p.name.includes(kw) || p.area.includes(kw));
  });

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

module.exports = { runOnce, resetSession };

if (require.main === module) {
  if (process.argv.length > 2) CONFIG.keywords = process.argv.slice(2);
  runOnce()
    .then(() => resetSession())
    .catch(async (e) => { console.error('エラー:', e.message); await resetSession(); process.exit(1); });
}
