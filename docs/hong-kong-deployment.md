# 独立域名与香港服务器：准备和部署

这份方案保留站内真题、PDF、做题记录和手机/iPad 同步。网站与 API 放在同一个域名，数据库和私人附件保存在自己的服务器磁盘，不依赖 Vercel。AI 工作端仍默认关闭，迁移服务器不会自动接通本机 Codex。

## 你先准备这些

### 1. 域名

在 [腾讯云域名注册](https://buy.cloud.tencent.com/domain) 选择一个简短、容易输入的 `.com`，按购买页完成实名认证。可以搜索 `7studyspace.com`，但这里没有查询或保留它，可注册状态以购买页面为准。已有域名时直接使用一个子域名即可，不必另买。

先看清首年价格和续费价格，通常先注册一年。域名和服务器放在同一个云账号里，后续管理更容易；域名后缀本身不决定国内访问速度。

### 2. 香港服务器

进入 [腾讯云轻量应用服务器](https://cloud.tencent.com/product/lighthouse)，参考 [Linux 实例创建指引](https://cloud.tencent.com/document/product/1207/44548)。以下规格是针对目前一名学习者的配置建议，不是压测承诺：

| 购买字段 | 选择 |
| --- | --- |
| 地域 | 中国香港 |
| 镜像 | 系统镜像 → Ubuntu 24.04 LTS，64 位 x86；没有时选 22.04 LTS |
| CPU / 内存 | 2 核 / 2GB 起步；预算允许可选 4GB，服务器构建更新更宽裕 |
| 磁盘 | 40GB 以上 SSD |
| 网络 | 带公网 IPv4；套餐带宽 5Mbps 左右或更高，结合实际可选套餐 |
| 数量与时长 | 1 台、先 1 个月，验证 77 的真实网络后再续费 |
| 登录 | 优先 SSH 密钥；私钥留在自己的电脑，通过控制台绑定公钥 |

不用购买数据库、WordPress/建站模板、付费 SSL 证书或额外的运维面板。服务器跑一份应用，SQLite 足够目前规模。

**香港地域不是大陆访问质量保证。** 腾讯云的 [地域与网络说明](https://cloud.tencent.com/document/product/1207/50103) 提醒跨境网络仍可能有延迟和丢包。优先考虑香港 [优选流量包](https://cloud.tencent.com/document/product/1207/104338)，先用 5GB 或 10GB 验证；这是额外付费项，购买后还要在实例“网络与域名”中 [开启加速](https://cloud.tencent.com/document/product/1207/104336)。流量包有有效期，用完或到期后的规则、服务器续费价都以当时控制台为准。若账号所在站点没有该选项，不要以其他地域或普通高带宽套餐代替线路核验。

香港服务器无需办理大陆 ICP 备案，域名实名认证仍按注册商要求完成。[腾讯云备案说明](https://cloud.tencent.com/document/product/243/18908)

### 3. 买好后提供的信息

- 最终域名，例如 `learn.example.com`。
- 服务器公网 IPv4、所选系统和规格、SSH 用户名。
- 是否已在本机配置 SSH 密钥登录。

这些足以继续部署。不要发送账号密码、SSH 私钥、一次性初始化口令或云服务密钥。域名解析、HTTPS、数据迁移和验收在准备好服务器后继续完成。

## 维护者部署步骤

以下命令供实际部署时使用；仅购买准备阶段不需要执行。示例域名/IP/路径要替换为实际值。整个部署使用单实例，不要为 SQLite 服务增加多个副本。

### 网络、系统与代码

1. 在域名 DNS 添加 A 记录：主机记录 `learn` → 服务器公网 IPv4，对应 `learn.example.com`。如使用根域名，主机记录填 `@`。不要添加没有配置好的 AAAA 记录。
2. 云防火墙允许公网 TCP 80/443，SSH TCP 22 限制为维护者当前 IP；不开放 4174 或数据库端口。
3. 依照 [Docker 官方 Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/) 安装 Docker Engine 和 Compose 插件，确认 Docker 服务开机启动。
4. 将代码放在 `/opt/7studyspace`。可为私有 GitHub 仓库配置服务器专用的**只读部署密钥**再克隆 `git@github.com:Olivia295/7StudySpace.git`；首次连接先核验 GitHub 官方 SSH 主机指纹。也可以用 SSH/SFTP 上传代码，排除 `.git`、`node_modules`、本机 `data`、`.env*` 和 `.vercel`；私人资料在后面的迁移步骤单独传输。

`.dockerignore` 使用白名单，只有应用代码与静态素材会进入镜像，私人题库、数据库、环境文件和登录凭据不参与构建。

### 准备持久数据与迁移

新服务器上创建目录：

```sh
sudo install -d -m 0700 -o 1000 -g 1000 /srv/study77/data /srv/study77/backups
```

**以旧正式站的最新记录为准，不能直接上传可能落后的本机 SQLite。** 正式切换前，让所有旧设备完成同步；每台设备再单独导出一份备份，保留尚未同步的内容。导出期间暂停在旧站做题。

在持有已配对会话的维护者电脑上，进入项目目录，用 Node.js 22.13 以上的 22.x 版本运行。先通过 `npm ci` 安装完整项目依赖（导出工具需要 TypeScript 来校验现有记录格式），再执行：

```sh
node scripts/export-cloud-for-server.mjs --session-file data/cloud-session.json --output data/hk-migration-01
```

脚本只读取旧站，导出学习状态及其引用的私人附件，并校验附件大小、摘要和导出前后记录版本；目标目录必须不存在。会话文件是此前迁移保存在本机的私人凭据，不提交 Git、不传到新网站。若它已失效，先重新配对取得有效会话，不要关闭旧站或跳过认证。

通过 SSH/SFTP 将导出目录中的 `study77.sqlite` 和整个 `files/` 目录放进新服务器**空的** `/srv/study77/data`，保留导出的清单供核对。设置数据所有者为 UID/GID 1000，目录 0700、文件 0600。如果该路径已有数据库，先备份并暂停，不能覆盖。

导出不迁移旧设备登录会话和服务端 AI 队列；学习状态中的记录、导入资料和草稿照常保留。新站首次初始化后重新配对各设备。没有旧数据的新空间可以跳过导出与上传步骤。

### 配置并启动

```sh
cd /opt/7studyspace/deploy/server
cp .env.example .env
```

编辑 `.env`：将 `STUDY77_DOMAIN` 设为实际完整域名（不带 `https://` 或末尾斜线），填写自己接收证书通知的邮箱。数据和备份路径默认分别是 `/srv/study77/data`、`/srv/study77/backups`。

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Caddy 自动申请、续期 HTTPS 证书并把 HTTP 转向 HTTPS，证书状态存在独立持久卷中。前提是 DNS 已正确解析且 80/443 可达。[Caddy 官方 HTTPS 说明](https://caddyserver.com/docs/quick-starts/https)

只在自己的服务器终端执行首次初始化：

```sh
docker compose exec app node server/bootstrap.mjs
```

将终端显示的一次性口令输入新站的连接页面，完成后失效；不要把它复制到聊天或公开日志。随后在已连接设备的“设置 → 配对另一台设备”中生成配对码，让 77 的手机与 iPad 连入新站。若从完整服务器备份恢复，空间通常已初始化，应改用 `node server/pair.mjs` 生成恢复配对码。

### 验收与正式切换

- 首页和 `/api/health` 正常；未连接时 `/api/state` 返回 401。
- 已连接设备核对真题、原卷及导入资料数量；打开真实 PDF 和音频。
- 保存一条练习/草稿后刷新，另一台已配对设备能看到同步结果。
- 重启 `app` 后数据仍在；未认证访问附件被拒绝。
- 由 77 在大陆 Wi-Fi 和手机网络分别验证打开、连续做题、PDF 阅读与同步，检查实际 iPad Safari。
- 确认后统一使用新域名，旧站暂时保留作为核对来源；不要让两个站点长期同时写入不同记录。浏览器旧地址里的本机记录不会自动搬到新域名，未同步部分用备份恢复合并。

完成这些检查才算迁移上线。香港网络仍需实际验收；服务器迁移也不能代替旧版 Safari 兼容性排查。

## 备份、更新与恢复

### 手动与每日备份

```sh
cd /opt/7studyspace/deploy/server
sh backup.sh
```

备份脚本使用 SQLite 一致快照，再按快照中的附件表复制并验证文件。成功的目录包含可独立使用的 `study77.sqlite`、`files/` 及清单，不依赖源数据库的 WAL 文件，也不拷贝 `.env` 等散落凭据。数据库内部有私人内容和会话哈希，整个备份仍应保密。

需要每天自动备份时安装已准备好的定时任务：

```sh
sudo cp study77-backup.service study77-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now study77-backup.timer
sudo systemctl start study77-backup.service
sudo systemctl status study77-backup.service
```

每天北京时间 04:00 左右执行，错过时补跑。备份保存在 `/srv/study77/backups`，先确认首次任务成功，再用 `journalctl -u study77-backup.service` 查看失败原因。至少每周把一份成功备份通过 SSH/SFTP 保存到自己电脑；同一磁盘上的备份无法抵御整机或磁盘丢失。脚本不自动删除旧备份，定期检查磁盘，确认异地副本可恢复后再整理旧目录。

### 更新代码

先备份，再在仓库拉取已通过检查的版本并重建：

```sh
cd /opt/7studyspace/deploy/server
sh backup.sh
git -C ../.. pull --ff-only
docker compose up -d --build
docker compose ps
```

数据库与附件在代码目录外，更新镜像不会覆盖它们。更换域名时需要同步修改 DNS 和 `.env` 后重建容器。

### 恢复

1. `docker compose stop app`，保留现在的数据目录，不覆盖。
2. 将选定成功备份复制到一个新的数据目录，确保有数据库及全部附件，修正 UID/GID 1000 和权限。
3. 修改 `.env` 的 `STUDY77_DATA_PATH` 指向该目录，然后 `docker compose up -d`。
4. 验证记录、附件和设备访问，再决定如何处理旧目录。需要重新配对时在容器内运行 `node server/pair.mjs`。

不要用 `docker compose down -v` 清理部署，它会删除 Caddy 的证书持久卷。不要直接拷贝运行中的 SQLite 主文件代替一致备份。

## 本次准备的验证范围（2026-10-04）

- 143 项自动测试通过，包含上传尚未完成时拒绝生成不完整备份、云端导出一致性及附件校验。
- Linux Docker 镜像构建通过；临时容器验证了生产模式鉴权、私人 JSON 附件往返、重启后记录保留和在线备份。
- Compose 配置与 Caddy 配置校验通过。测试容器和假数据卷已清理，没有改动真实学习资料。
- 尚未购买服务器或域名，未迁移真实云端数据；公网 HTTPS、服务器定时任务和大陆真机访问需在实际部署时验收。
