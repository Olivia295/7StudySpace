import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, issueBootstrapToken } from './store.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = openStore(process.env.STUDY77_DATA_DIR || path.join(rootDir, 'data'));
try {
  const token = issueBootstrapToken(store);
  console.log('以下一次性口令仅用于首次初始化，请在学习空间的连接页面输入。不要发到聊天、代码仓库或公开日志中。');
  console.log(token);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  store.close();
}
