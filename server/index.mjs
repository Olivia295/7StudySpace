import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';
import { inspectCodexRunner, runCodexJob } from './codex-runner.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4174);
const host = process.env.HOST || '127.0.0.1';
const requestedWorker = process.env.STUDY77_CODEX_WORKER === '1';
const capability = requestedWorker ? inspectCodexRunner() : { ready: false, reason: 'CODEX_WORKER_DISABLED' };
const runtime = createApp({
  dataDir: process.env.STUDY77_DATA_DIR || path.join(rootDir, 'data'),
  distDir: path.join(rootDir, 'dist'),
  runJob: capability.ready ? runCodexJob : undefined,
  disabledReason: capability.reason,
});
const listener = runtime.app.listen(port, host, () => {
  console.log(`77 的学习空间服务已启动：http://${host}:${port}`);
  console.log(capability.ready ? '受限 Codex 本机工作端已开启。' : `AI 工作端关闭：${capability.reason}。学习记录与设备配对可正常使用。`);
  if (runtime.store.getMeta('initialized') !== '1' && process.env.NODE_ENV === 'production') {
    console.log('首次部署：请在服务器自己的终端运行 node server/bootstrap.mjs 获取一次性初始化口令。');
  }
});
function shutdown() {
  listener.close(() => { runtime.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
