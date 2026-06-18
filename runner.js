/**
 * 常駐ループ（Fly.io用）
 * INTERVAL_SEC 秒ごとに watcher.runOnce() を実行。
 * セッション（ログイン状態）はwatcher側で使い回す。エラー時はリセット。
 */
const { runOnce, resetSession } = require('./watcher');

const INTERVAL_MS = (parseInt(process.env.INTERVAL_SEC, 10) || 180) * 1000;

async function loop() {
  try {
    await runOnce();
  } catch (e) {
    console.error('実行エラー:', e.message);
    await resetSession(); // 次回はクリーンに作り直す
  }
  setTimeout(loop, INTERVAL_MS);
}

// 停止シグナルでブラウザを片付ける
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await resetSession(); process.exit(0); });
}

console.log(`JKK監視ループ開始（間隔: ${INTERVAL_MS / 1000}秒・セッション使い回し）`);
loop();
