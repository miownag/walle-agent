# 验证

- `pnpm build`：通过；最终 Desktop 构建通过。
- SDK：59 个测试文件，538 个测试通过。
- Desktop：33 个测试文件，155 个测试通过。
- Desktop TypeScript 类型检查通过，`git diff --check` 通过。
- 真实 Walle 窗口确认 Base URL 的 optional 同行右侧显示，输入框与默认模型对齐，模型编辑区展示 Label、Value、Description 和 Add model。
- 回归覆盖可选 label 回退、模型列表编辑、聊天选择的实际 value、独立会话模型持久化、非法选择原子拒绝和自定义端点凭据边界。
- 本机 HTTP 集成测试确认所选 value 发送到配置的 Anthropic Base URL，而不是厂商默认端点或进程环境中的其他地址。

- 开发启动启用 main/preload watch；新 Electron 主进程已运行。真实 Ferry Provider 保存后，本地 desktop-state.json 回读两个模型，聊天模型菜单同时展示普通 Opus 5.5 与 Opus 5.5 Max。
