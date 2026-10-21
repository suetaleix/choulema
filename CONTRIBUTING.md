# 贡献指南 / Contributing

感谢你愿意参与「抽了马」！ Thanks for your interest in Choulema!

## 提交问题 / Issues
- 提交前请搜索已有 Issue；描述复现步骤、浏览器/系统版本和期望行为。
- **安全漏洞请勿公开提交**，请私下联系维护者。 Please report security issues privately.

## 开发流程 / Workflow
1. Fork 并基于 `main` 新建分支：`feat/xxx`、`fix/xxx`。
2. 安装依赖：`pip install -r requirements.txt -r requirements-dev.txt`。
3. 运行测试：`python -m pytest`（Python）与 `node --test tests/`（前端模块，Node 20+）。
4. 保持改动小而专注；不要提交 `.env`、数据库、密钥、日志或构建产物。
5. 提交 PR，说明动机、改动范围和测试结果。

## 约定 / Conventions
- 抽取结果只能由服务端决定；渲染器只展示结果。 Draw results are server-authoritative.
- 支付、权益、卡密相关改动需附带测试并在 PR 中重点说明。
- 已发布的内容 ID / 数据表不重命名，迁移须幂等。
- 新增音频/图片素材须注明来源与许可（CC0 / 自制优先）。

提交贡献即表示你同意以本项目许可证（Apache-2.0）授权你的贡献。
By contributing, you agree your contributions are licensed under the project license.
