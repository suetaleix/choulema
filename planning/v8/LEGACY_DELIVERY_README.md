# 抽了马 V8 · 3D 抽奖系统

**免费抽，尽兴玩。** 四种用途、三台免费 3D 机台，付费内容提供更好的主题与进阶功能体验，不改变抽取概率。

V8.0.0 以 2026-10-01 已确认并上线的透明极光星盘版为基线，统一版本、当前规划、启动和交付方式。具体范围见 [V8 总规划](planning/v8/MASTER_PLAN.md)，工作入口见 [V8 文档索引](planning/v8/README.md)。本交付包不包含生产数据库、管理员密码或支付宝密钥。

当前交付：**2026-10-09 用户反馈版**，先读 [本版交付必读](planning/v8/HANDOVER_20261009.md)。检查记录见 [本地验收与部署准备](planning/v8/FEEDBACK_ACCEPTANCE_20261009.md)。本轮应用户要求制作交付包，未更新线上；真实邮件收信与体验确认单独验收。

上次交付：**2026-10-07 邮箱注册版**，包含两轮本地 UI 优化和邮箱注册。先读 [交付必读](planning/v8/HANDOVER_20261007.md)，再按部署指南操作。真实邮箱投递仍需收件验证。

## 先看这几个文件

| 需要做什么 | 入口 |
|---|---|
| 了解产品与 UI、免费及收费范围 | [产品总规划](planning/v8/MASTER_PLAN.md) |
| 了解代码和数据、增加收费机台/主题/功能 | [架构与扩展](planning/v8/ARCHITECTURE.md) |
| 安排基础开发、按任务卡继续执行 | [开发执行计划](planning/v8/DEVELOPMENT_PLAN.md) |
| 查看已验证内容与未覆盖边界 | [验收基线](planning/v8/ACCEPTANCE.md) |
| 安装服务器、升级和回退 | [部署指南](deploy/README.md) |
| 区分完整源码包与部署包 | [交付说明](planning/v8/DELIVERY.md) |

`planning/v8/` 是当前规划入口；`planning/v7/` 和 `planning/dev/` 保留历史设计与验收证据，旧文档中的“未上线”“销售关闭”等结论须结合记录日期阅读。

最新本地候选采用邮箱验证码注册，账号 ID 自动生成，无需手机号；已有账号可用 ID 登录。配置与验收见 [邮箱注册记录](planning/v8/EMAIL_REGISTRATION_20261007.md)。

## 本地启动

要求 Python 3.11 或以上。第一次安装依赖需要网络；正常运行的机台、字体、音效与 Three.js 从本站加载。

Windows PowerShell，在解压后的 `lottery-platform` 目录运行：

```powershell
.\scripts\start_v8.ps1
```

第一次会建立 `.venv` 并安装运行依赖；默认地址是 <http://127.0.0.1:8908/login.html>。如端口被占用：

```powershell
.\scripts\start_v8.ps1 -Port 8910
```

需要本地超级管理员时执行 ` .\scripts\start_v8.ps1 -Admin `，按提示输入手机号和密码。已有本地管理员不会被重置。没有通用默认账号或固定密码。

不使用 PowerShell 脚本时，可直接运行 Python（Linux/macOS 将 `.venv/Scripts/python.exe` 改为 `.venv/bin/python`）：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe scripts/start_local.py
```

本地启动器固定使用本项目 `data/v8-local.sqlite`、监听 `127.0.0.1`、关闭在线销售，并清除进程继承的生产数据库和支付宝配置；不加载真实生产配置。`--check` 只验证依赖和版本，不创建数据库。退出运行中的终端用 Ctrl+C。

## 三个主页面

- `/login.html`：介绍、直接免费体验、登录与注册；玩法和收费说明在二级弹层。
- `/play.html`：满屏游戏舞台；候选、规则、外观、记录、账户、邀请、卡密和订单都在游戏内打开。
- `/admin.html`：独立超级管理员入口；页面和接口均鉴权。

默认最高画质、完整动画；点击机台或按空格抽取。输入框、面板和结果按钮保留正常键盘行为。原生全屏被浏览器拒绝时，继续使用页面内满屏舞台。

## 固定产品基线

| 项目 | V8 行为 |
|---|---|
| 用途 | 抽吃什么、抽玩什么、抽奖品、抽点名；活动只输出选择，不编排日程 |
| 免费机台 | 经典转盘、胶囊机、姓名星球；免费注册与基础体验，不按次数收费 |
| 默认主题 | 三种批准音效：经典叮当、霓虹街机、糖果弹珠 |
| 星空主题 | 覆盖三机台，透明极光转盘；三种音效：星铃幸运、银河流转、极光礼赞 |
| 初始商品价格 | 星空 9.90 元/365 天、专业功能 99 元/365 天，手动购买续期，不自动扣款 |
| 配置优先级 | 超管已保存的价格、活动、权益与销售设置优先；升级不覆盖这些数据 |
| 邀请 | 后台可配置专业功能天数和指定皮肤；按已发布规则发放 |
| 卡密 | 会员与指定皮肤分开；30/90/365 天或自定义 1–3650 天 |

输入边界：转盘最多 48 项、每次 1 项；胶囊和姓名球候选最多 1000、每次最多 50 项；姓名球支持分组。这些是服务端上限，不是所有手机的性能承诺。

## 测试与打包

完整源码包包含测试及历史音色参考；服务器部署包不包含这些开发资源。

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q --basetemp artifacts/test-v8-new
node --test tests/*.test.mjs
.\.venv\Scripts\python.exe scripts/package_preview.py --output artifacts/choulema-v8-source.zip --include-untracked
.\.venv\Scripts\python.exe scripts/package_preview.py --output artifacts/choulema-v8-server.zip --release --include-untracked
.\.venv\Scripts\python.exe scripts/package_preview.py --verify artifacts/choulema-v8-source.zip
```

输出文件必须是新路径。打包器校验必需入口、批准音频和逐文件哈希；解压后即使没有 Git，仍可依据 `PACKAGE.json` 重新构建，不会扫描打包任意个人目录。

## 代码兼容与部署边界

产品版本已统一为 `8.0.0`，内容目录 schema 继续为 1。现有 `/api/v6`、`/api/v7`、`static/v6`、`static/v7` 和 Python 模块名保留为兼容路径；它们不是产品显示版本。避免无业务价值的目录搬迁导致收藏链接、订单回调或已购权益失效。

生产由专用服务账号、单进程应用及 SQLite 构成，数据库与密钥位于源码之外。支付宝为电脑/手机网站支付直连；退款和付款通知必须验签。新环境销售默认关闭，已上线环境升级沿用原设置。V8 打包不等于把任意新服务器配置成可收款，也不代表本次已将线上版本再次升级为 V8；线上已验证基线见 [发布记录](planning/v7/AURORA_DEPLOYMENT_20261001.md)。
