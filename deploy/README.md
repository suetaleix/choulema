# V8 部署与升级

V8.0.0 以用户确认并上线的透明极光星盘版为功能基线，整理版本、文档与便携启动/交付工具。本轮仅交付包，不自动再次更新生产。当前状态与验证边界见 [V8 验收](../planning/v8/ACCEPTANCE.md)，此前实际发布见 [极光发布记录](../planning/v7/AURORA_DEPLOYMENT_20261001.md)。

使用单进程 Uvicorn + SQLite；不要直接增加 workers，部分请求限流状态仍在内存中。2026-10-07 邮箱注册交付包含兼容数据库迁移（手机号可空、唯一邮箱、验证码与发信限流表），必须停服备份并核验原记录；商品 ID、支付逻辑和旧权益保持兼容。交付入口见 [本次交付必读](../planning/v8/HANDOVER_20261007.md)。

## 2026-10-09 反馈候选升级说明

新反馈模块为 `v8_feedback.py`，前端资源在 `static/v7/feedback*` 与 `admin-feedback.mjs`，交付工具已加入必需文件校验。无需新增第三方依赖或外部服务。

必须沿用停服备份、离线迁移和原行验证流程。新增 `v8_feedback`、`v8_feedback_replies` 表；原 `feedback` 表保留，只将历史记录按原编号导入一次。`settings.feedback_hash_key` 是自动生成并随数据库备份的摘要密钥，不需人工配置，也不要删除或随意更换。游客归属继续使用既有 `v6_guest_handoffs`。

反馈为纯文字，每身份滚动 24 小时最多 5 条、两次新反馈至少相隔 30 秒；同网络每天 20 条、全站每天 1000 条。正确配置可信反代来源，避免所有访问都按代理 IP 限流。已成功的同一请求重试不重复创建、不再次扣限额；旧 `/api/feedback` 接口共用限流。

发布后用普通账号提交一条测试反馈，超管回复，再回普通账号确认可见；用另一个账号确认无法读取。真实用户反馈和内部备注属于业务数据，应与账号、订单一起备份，不能放入公开源码包。当前只有站内回复，不自动给填写的邮箱发送通知。

本轮仍为本地待验收候选；没有替换线上服务。实际邮件收信和用户验收通过后再出新包，生产服务器的 SMTP、HTTPS、支付宝配置须另行检查。

## 目录

- `/opt/choulema/releases/8.0.0-唯一时间/`：本次代码，单独建立 `.venv`，安装固定的 requirements.txt。解压包有一层 `lottery-platform/`，需确保服务指向含 `server.py` 的目录。
- `/opt/choulema/current`：指向正在运行的版本。保留上一版本代码和其虚拟环境。
- `/var/lib/choulema/lottery.sqlite`：持久业务库。不要用项目内 data 或本地验收库替代生产库。
- `/var/backups/choulema/`：只对服务账号开放的备份；定期另存服务器之外。
- `/etc/choulema/production.env` 与独立私钥文件：运行配置，不放代码包和 static 中。参考 production.env.example，真实值由服务器管理员填写。

用专用 `choulema` 账号运行，业务库及备份目录需可写。代码与密钥权限分别设置；不要把整个应用目录映射成网站静态根目录。

## 首次启动

1. 在本地先校验下载包：`python scripts/package_preview.py --verify 候选包.zip`。校验成功后解压到新版本目录。
2. 用 Python 3.11 或以上创建虚拟环境：`python3 -m venv .venv`，运行 `.venv/bin/python -m pip install -r requirements.txt`。
3. 复制生产环境模板到 `/etc/choulema/production.env`，填写真实域名、绝对数据路径、初始管理员与独立随机卡密密钥。模板文件不会自动被应用读取；本项目的 systemd 模板通过 EnvironmentFile 加载。
4. `LOTTERY_CARD_SECRET` 只生成一次并保管，升级始终沿用；更换会导致旧卡密不能验证。首次空库需设置初始管理员，初始密码至少 10 位；启动成功后从环境文件移除初始化密码。不能把本地测试账号作为正式管理账号。
5. 按服务器路径核对 `lottery.service` 后安装为 systemd 服务，重载服务配置并启动。`ExecStartPre` 自动执行 `scripts/preflight.py`，检查失败会阻止生产启动。命令行手动检查须先在进程环境加载同一份配置。
6. 反向代理把真实 HTTPS 域名转发到 `127.0.0.1:8901`，保留 Host，并设置 X-Forwarded-Proto / X-Forwarded-For。8901 不直接对公网开放。证书和域名在服务器配置，不写在源码。
7. 访问 `/healthz`，应返回 `status=ok` 和当前版本。再验收 `/login.html`、`/play.html`、`/admin.html`。健康响应不包含路径、密钥或用户数据。

生产环境路径、HTTPS、密钥未填完时，启动检查会明确报错；不能为了跳过检查把生产伪装成 development。

## 升级

1. 在独立验收环境试新包，确认目录兼容、音画和权限；备份当前环境文件及卡密密钥。
2. 选择维护窗口，提示用户结束当前演出。停止服务，确认没有其他进程写该 SQLite 库。支付平台这段时间的通知可能稍后重试；升级恢复后主动查单补齐。
3. 在新版本环境执行：
   `python scripts/manage_db.py migrate --database /var/lib/choulema/lottery.sqlite --output /var/backups/choulema/before-8.0-唯一时间.sqlite`
   输出目标必须不存在。此命令先备份，再执行幂等增量初始化、完整性检查，并比较原表所有原字段和原记录，禁止静默丢失或改变旧数据。
4. 只有迁移校验成功才能把 current 指向新版本并启动。健康检查、登录、一次抽取、已售权益及历史订单查询均通过后，结束维护。
5. 保留备份和上一版本，不在升级脚本中自动删除。若迁移或检查失败保持服务停写，保留现场及日志，由管理员决定恢复。

## 回退与恢复

通常只回退代码。先确认上一版本能识别当前目录 ID 和数据库结构；新版本已经售出新内容时，不能回退到不认识这些内容的旧代码。退回兼容代码时继续用当前业务库，保留升级后的账号、订单和权益。

仅灾难恢复才使用数据库备份，且先明确备份时间之后的数据如何对账补齐。恢复命令只写新路径：
`python scripts/manage_db.py restore --database /var/backups/choulema/选定备份.sqlite --output /var/lib/choulema/新恢复文件.sqlite`
不要直接覆盖正在使用的库；验证新库后再调整配置。`--output` 已存在时工具拒绝覆盖。

## 邮箱注册配置（2026-10-07 本地候选）

新注册要求邮箱验证码；未配置 SMTP 时注册发码关闭，旧账号登录和免费体验正常。配置示例见 `.env.example`；服务端设置 `LOTTERY_MAIL_CONFIG_FILE=/etc/choulema/mail.json`。私密 JSON 内容示意：

```json
{"host":"smtp.example.com","port":465,"security":"ssl","username":"sender@example.com","sender":"sender@example.com","password_file":"/etc/choulema/smtp-password"}
```

只支持校验证书的 SSL 或 STARTTLS；`password_file` 保存邮箱 SMTP 授权码，勿使用网页登录密码。私密配置、授权码均放在发布目录和静态目录之外，仅服务账号可读，不入源码包或日志。允许 JSON 中直接保存 `password`，与私钥一样管理文件权限。保留稳定的 `LOTTERY_CARD_SECRET`，重启后验证码才能在有效期内继续校验。

旧库升级先停止应用，用 `scripts/manage_db.py migrate` 生成独立快照并核验原记录。迁移保留旧账号、会话、订单和权益，将手机号列改为可空，添加唯一邮箱和验证时间；不把旧手机号推断成邮箱，不删除账号。产生邮箱账号后，代码回退版本也必须支持邮箱身份，不能直接退回只支持手机号的旧登录实现。上线前需实测收件、注册、邮箱登录、邀请奖励与禁用账号。尚未上线本候选时不得把本地通过当作生产验收。

本地启动需显式指定 `python scripts/start_local.py --mail-config /private/mail.json`，Windows 可用 `scripts/start_v8.ps1 -MailConfig C:\private\mail.json`；普通启动不会自动继承生产邮箱或支付宝配置。

## 收款配置与保留

当前对接支付宝电脑网站支付和手机网站支付；当面付原生二维码不在本版。应按现有接口开通对应商户产品。

现有站点的支付宝已经配置，用户已反馈真实付款及退款成功。升级时沿用既有商户配置、后台价格、开关和订单，不把示例配置覆盖到生产环境。本轮 V8 打包没有新增真实资金交易证据。

全新安装需配置 app_id、seller_id、商户私钥路径、支付宝公钥路径和公网 HTTPS 地址。保持 `V6_SALES_ENABLED=0`，先核对配置和商品，随后在专门验收窗口放行销售并用真实小额订单验证付款、异步通知、主动查单、重复通知、续期、退款及异常补发。需同时满足环境销售开关、后台销售开关和商品上架。

切勿通过数据库改“已支付”替代商户验收。暂停新销售不关闭回调或历史订单核对。商户真实配置及服务器验收结束前，不能标记生产收款完成。

## 本地启动与构建新包

Windows 运行 `scripts/start_v8.ps1`；其他平台安装 requirements.txt 后执行 `python scripts/start_local.py`。默认 8908、绑定 127.0.0.1、独立 data/v8-local.sqlite、在线销售关闭。首次需要本地超管时加 `--admin`（PowerShell 用 `-Admin`），交互输入账号密码；已有超管不会被重置。`--check` / `-Check` 只检查依赖和版本，不创建数据库。本地启动器会主动清除继承的商户与生产环境变量，因此**生产服务仍用 systemd + Uvicorn**。

从审核过的工作区执行：
`python scripts/package_preview.py --output 绝对路径/新版本.zip --release --include-untracked`

`--include-untracked` 显式包含本项目尚未提交的新源码；工具仍排除 data、artifacts、密钥、数据库与缓存。发布模式排除旧预览音画、测试目录及素材生成脚本。正式音频必须与清单哈希一致，遗漏或被改动即拒绝打包。PACKAGE.json 记录版本、源提交、工作区是否有改动以及逐文件哈希，不把未提交源码伪装为干净提交。解压源码没有 Git 时使用随包清单作为文件基线，新增源码仍需显式加 `--include-untracked`。
