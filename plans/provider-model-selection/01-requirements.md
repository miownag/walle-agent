# Provider 模型选择

- 修正 Base URL optional 的同行右侧布局。
- 每个 Provider 支持多个模型，字段为 label、value、description。
- label 与 description 可选，label 留空时展示 value。
- 聊天中可切换模型，实际请求使用 value。
- 保留旧配置、已有会话模型选择和安全存储中的 key。

Provider edits preserve ordering. The default provider is always displayed first; non-default profiles retain relative order. The selected model uses a check icon.
