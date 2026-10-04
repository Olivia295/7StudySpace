# 77 私有学习空间服务

Node 22 的 `node:sqlite`、Express 和 Zod。服务默认只绑定 `127.0.0.1:4174`。状态和 AI 队列存入 `data/study77.sqlite`，不依赖内存或浏览器才能保存。

## 启动与首次连接

开发环境从同源前端调用 `GET /api/session`，仅当**第一次初始化、真实来源是本机回环地址、Host 为 localhost/127.0.0.1、没有转发头**时自动建立 HttpOnly 设备会话。初始化后，其他设备必须配对。

生产部署设置 `NODE_ENV=production` 与 `STUDY77_PUBLIC_ORIGIN=https://你的域名`。使用 HTTPS 反向代理，同源提供前端与 `/api`；不要直接开放开发服务器。运行 `node server/bootstrap.mjs` 在服务器自己的终端获得首次使用的一次性口令，再在连接页面提交。口令只显示在该终端，不应保存到仓库或分享给其他人。初始化完成后该口令失效。

`HOST` 默认 `127.0.0.1`，`PORT` 默认 `4174`，`STUDY77_DATA_DIR` 可指定 SQLite 数据目录。生产环境 Cookie 带 Secure；本地 HTTP 用开发模式。数据库备份时先停止服务，或使用 SQLite 在线备份工具；运行中的 WAL 数据库不要只复制主文件。

## API

除 health、session、bootstrap、pairing/claim 外，所有 API 必须携带有效 Cookie 或由私有服务代码持有的设备 Bearer token。浏览器使用 `credentials: 'same-origin'`；不要把 token 放入 localStorage 或 URL。

| API | 请求 / 返回 |
| --- | --- |
| `GET /api/health` | `{ok,service,version}`，不暴露记录 |
| `GET /api/session` | `{authenticated,needsBootstrap,localBootstrapAvailable}` |
| `POST /api/bootstrap` | `{token}` → `{ok:true}` 与会话 Cookie；仅首次可用 |
| `POST /api/logout` | JSON `{}` → 撤销当前设备会话 |
| `GET /api/state` | `{state:{...},revision,updatedAt}` |
| `PUT /api/state` | `{state:{...},revision}` → 新快照；旧 revision 返回 409 与 `{error:'revision_conflict',state,revision,updatedAt}` |
| `POST /api/pairing` | JSON `{}` → `{code,expiresAt}`，10 分钟、一次性 |
| `POST /api/pairing/claim` | `{code}` → `{ok:true}` 与新会话 Cookie |
| `POST /api/files/:id` | 已鉴权 raw body，最多 30 MB；`Content-Type` 指定类型，`X-Filename` 可传 URL 编码文件名 → `{id,mimeType,name,size}` |
| `GET /api/files/:id` | 已鉴权原件下载，支持音频 Range；不公开文件目录 |
| `GET /api/ai/status` | `{enabled,provider:'codex-local',reason,message}` |
| `POST /api/ai/jobs` | 见下方，202 新建 / 200 去重 → `{job,duplicate,worker}` |
| `GET /api/ai/jobs/:id` | `{job,worker}` |

AI 请求：`{kind:'tutor'|'review'|'extract',prompt,context?,persona?,attachment?,dedupeKey?}`。`context` 是字符串或 JSON 对象；`persona` 是字符串。附件格式 `{name,mimeType,dataUrl?,text?}`；图片支持 PNG/JPEG/WebP 的 base64 data URL，文本用 `text/plain` 和 `text`。不从 URL 下载附件，不接受文件系统路径。PDF 和 DOCX 先在前端安全提取文字。

Job：`{id,kind,status,result,error,createdAt,updatedAt}`。状态是 `queued/running/completed/failed/unavailable`。`result` 至少包含 `text`，`error` 包含 `code/message`。未接入 AI 时仍保存请求，状态明确为 unavailable，不生成假答案。

周复盘必须包含真实 context。相同 context 的键排序标准化后去重，与按钮重试、提示词或人设更换无关。前端仅每 7 天有新学习数据时触发；不要把当前时间放进用于去重的 context。普通请求可传重试幂等键 `dedupeKey`。

原件 ID 为 8–100 位字母、数字、下划线或连字符，推荐 UUID。上传支持 PDF、PNG/JPEG/WebP、常见音频、纯文本/CSV；HTML 和可执行文件不接受。同 ID 的相同内容重传幂等，不同内容返回 409。客户端在学习材料中保存文件 ID，本机离线副本继续保留在 IndexedDB。原件位于 `data/files/`；JSON 备份需由客户端同时包含原件内容。

## 本机 Codex 工作端的安全边界

2026-10-04 本机验证 `codex-cli 0.156.1`：真实纯文本翻译返回 `turn.completed`。额外两次无害工具阻断检查确认 Code Mode 因 `code_mode_host=false` 关闭而拒绝调用；直接 collaboration 工具被静态 `PreToolUse` hook 以 `STUDY77_TEXT_ONLY` 标记拒绝。未读取、复制或输出认证文件、API key、访问令牌。

默认关闭 AI。仅在持有本人 Codex 登录的服务器本机显式启动：

```sh
STUDY77_CODEX_WORKER=1 npm start
```

可选 `STUDY77_CODEX_BIN` 指定本机 Codex 可执行文件。worker 锁定已验证的 `0.156.1`，版本不符自动关闭，防止升级后静默改变工具边界。`codex-runner.mjs` 不读取用户配置、规则或项目说明，关闭 shell、unified exec、MCP、插件、浏览器、联网搜索、图片工具及技能发现，使用独立临时目录与 read-only 沙箱；不继承 `OPENAI_API_KEY`。资料通过标准输入或单独图片参数传递，任务有 120 秒超时，结束清理临时资料。

剩余本地工具由固定 `deny-tools.mjs` hook 在运行前拒绝。`--dangerously-bypass-hook-trust` 仅用于本次受审查的静态拒绝 hook，不包含用户可更改的命令。模型可以看见部分工具名字，但执行受到阻断；这与仅在提示词中要求“不调用工具”不同。[官方 hook 文档](https://learn.chatgpt.com/docs/hooks) 说明本地函数、apply_patch 和 Agent 的阻断机制，也指出 hook 并非独立的完整沙箱。因此还有禁用 Code Mode/执行工具、read-only 与版本锁定等独立限制。

这是经过本机验证的受限知识任务工作端，尚未进行操作系统容器级隔离或跨版本验证。Mac 不在线、版本不符或工作端关闭时任务保留为 unavailable；启用后重新排队。公开部署、手机/iPad 网络可达性和订阅使用资格需独立验证。不要将完整 Codex app-server 控制端口公开给网页。

## 安全与验证

随机 256 位设备令牌只保存 SHA-256；设备 Cookie 为 HttpOnly、SameSite=Strict。配对码为 10 位无歧义字母数字字符，数据库只存哈希；单次消费通过 SQLite 条件更新实现。配对和初始化有请求频率限制，不信任外部转发头。状态写入使用 revision 条件更新；所有用户内容视为数据。

运行 `node --test tests/server.test.mjs`。测试在临时目录使用假数据，不读取真实用户认证、不调用模型。
