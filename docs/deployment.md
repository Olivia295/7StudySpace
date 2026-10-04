# Vercel 部署与私人数据

本项目分为静态 React 页面、同源 Node.js API 和私有 Blob 存储。`data/`、环境变量、SQLite、备份与认证文件不提交 Git，也不进入 Vercel 构建。

## 配置

- Node.js 22.x；`npm ci` 安装，`npm run build` 构建。
- Vercel 项目采用 Vite、`dist` 输出、`hkg1` 函数区域。
- 给 production 连接一个 `access=private` 的 Blob store，提供 `BLOB_READ_WRITE_TOKEN`。不要为预览分支连接正式私人存储。
- 首次提供 `STUDY77_BOOTSTRAP_HASH`，其值为随机 32 字节 base64url 口令的 SHA-256；明文仅临时保存在所有者本机，不提交、不打印、不放进网址。
- 可选 `STUDY77_PUBLIC_ORIGIN` 固定正式 HTTPS 来源；默认使用 Vercel 的正式域名。不要放宽同源检查来绕过代理或浏览器扩展错误。
- 首次初始化后，口令不能再次使用。已有设备使用一次性配对码添加新设备；每台设备各自使用 HttpOnly、Secure、SameSite=Strict cookie。

私有 JSON 文档使用最新读取与 ETag 条件写入，处理并发修订和一次性配对。正文状态上限 3.5MB；单个附件仍为 30MiB，按不超过 3MB 分块上传下载，服务端和客户端均验证 SHA-256。内置课程不会占用个人同步正文。

页面没有修改时不重写状态。可见页面每 5 分钟检查同步，编辑、重新聚焦和恢复联网也会触发。Blob 有存储与请求额度；超限或故障时显示同步失败，本机记录保留，设置中的导出备份仍可使用。

## 首次迁移现有本机空间

保持 `data/cloud-bootstrap` 为初始化明文口令（文件权限 0600）。部署好生产地址后执行：

```sh
node scripts/migrate-cloud.mjs --url=https://your-production-domain
```

此占位地址必须替换为实际正式域名。脚本读取 SQLite 的完整一致状态，通过认证 API 上传当前资料引用的附件，验证文件摘要，再写入状态；云端已有不同记录时会停止，不覆盖。连接凭据保存到忽略的 `data/cloud-session.json`。不要把该文件分享、提交或上传到静态资源目录。

首次迁移结束后，应在正式网页连接所有者设备，核对真题数量、原卷、保存后刷新和设备配对。原本 localhost / 127.0.0.1 浏览器中的未同步记录仍在原设备，需用设置导出备份并在正式网址恢复合并。

## AI 与本机版本

云端暂未连接本机 Codex 工作端，普通练习、配对与记录同步可独立使用。AI 请求以不可用状态保留，不会假报完成；本机 `STUDY77_CODEX_WORKER=1 npm start` 的功能不受影响。不要把 Codex 登录文件或完整控制端口部署到公网。

## 验证

`npm test` 包含本机 API、云端状态竞争、认证、分块文件完整性等检查；`npm run build` 检查 TypeScript 和生产包。线上还需检查 `/api/health`、未授权 `/api/state` 拒绝、配对后真题和附件可读、记录保存后刷新不丢失。Git 推送不等于部署成功，以 Vercel READY 和正式网址实测为准。
