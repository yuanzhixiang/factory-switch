# 项目版本与打包配置

## 职责

`package.json` 定义 Factory Switch 的版本、依赖、验证命令和 Electron 打包配置。当前版本为 `0.0.3`，对应 GitHub 标签 `v0.0.3`。

## 构建与验证

- `pnpm test` 使用临时目录验证核心逻辑，不操作真实 Factory 凭证。
- `pnpm lint` 执行 ESLint。
- `pnpm build` 依次执行 TypeScript 检查、主进程及 preload 构建、页面构建。
- `pnpm dist` 构建未签名的 macOS 应用目录，保留本机安装流程。
- `pnpm dist:release` 构建 Apple Silicon 的 DMG 和 ZIP，输出到 `release/`；`--publish never` 禁止打包工具自动上传。

## 发布附件

- 安装包按 `Factory-Switch-<版本>-arm64.dmg` 和 `Factory-Switch-<版本>-arm64.zip` 命名。
- 发布时附带 `SHA256SUMS.txt`，包含 DMG 和 ZIP 的 SHA-256 校验值。
- DMG 用于将应用拖入 `Applications`；ZIP 用于直接解压获取应用。
- 当前发布不提供 Intel Mac 安装包，不执行代码签名或 Apple 公证。

## 安全边界

- 应用代码仅从 `out/` 和项目 `package.json` 打包，运行依赖由 electron-builder 收集；本机账号备份和 API Key 不属于打包输入。
- 打包和静态验证不启动应用，不触发真实账号的用量查询或切换。
- GitHub 发布由人工明确授权后执行，版本标签指向已通过验证的提交。
