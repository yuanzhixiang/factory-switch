# factory-switch 约定

- 与用户对话、代码注释、文档都用简体中文；代码标识符用英文。
- 每次改动完成并验证后都要提交，并推送到 `origin main`（https://github.com/yuanzhixiang/factory-switch）。
- 提交前必须通过：`pnpm test`、`pnpm lint`、`pnpm build`。
- 改动行为后同步更新 `README.md` 里的「行为」「已知限制」章节。
- 不要在本地真实执行「切换」「删除本地凭证」来验证：它们会退出 Factory 桌面版，而 agent 自身运行在其中。用 `test/` 里的临时目录测试覆盖。
- 发布到本机：`pnpm dist` 后用 `ditto` 把 `release/mac-arm64/Factory Switch.app` 复制到 `/Applications/`。
