# 设计

Provider 保留 model 作为默认 ID，新增可选 models 列表。共享 helper 兼容旧配置并规范化展示名称。Provider 表单编辑列表；聊天菜单展示名称、说明和所属 Provider。

Thread 的 model 独立持久化。IPC 校验选择并在模型变化时使 runtime 失效；Agent 与标题生成使用 thread 的 Model ID。Anthropic Base URL 显式传入 SDK。
