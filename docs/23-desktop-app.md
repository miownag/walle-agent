# 23 — Walle Desktop App

## 定位

Walle Desktop 是 monorepo 内的 local-only Coding Agent 桌面应用。它不是一个新的 Agent runtime；它通过安全的 Electron main/preload 边界组合 `@walle-agent/*` 包，并为多会话、审批、工作区、可视化执行过程和本地设置提供产品层。这里的 local-only 指没有 Walle 云端账号、同步或遥测后端；会话索引、运行记录和设置保存在本机。模型调用仍会按用户配置把必要的 prompt、文件/工具上下文发送到对应 AI Provider，Evolution review 启用时也会把近期上下文发送给该 Provider，UI 必须明确披露这一点。

首期以 macOS 为主，技术栈为 Electron + React + Vite、pnpm、最新 shadcn/ui 源码组件与 `@tabler/icons-react`。

## 目录与边界

```text
apps/desktop/
  src/main/       Electron 主进程；SDK、文件、子进程、凭据
  src/preload/    contextBridge + typed IPC
  src/renderer/   React UI；无 Node 权限
  src/shared/     仅 JSON-safe DTO、schema 和纯函数
```

Renderer 必须启用 `contextIsolation`，关闭 `nodeIntegration`，不得直接 import Walle SDK。Provider key 使用 Electron `safeStorage`，IPC 只返回 masked 状态。

## 会话模型

- 一个 thread 对应一个稳定的 `sessionId` 和一个惰性创建的 `Agent`。
- 同一 thread 同时只能有一个 run；不同 thread 的 Agent 可以并行。
- `MemoryPlugin` 保存模型消息；DesktopStore 另存 title、workspace、provider、pin/archive 与 UI timeline。
- 新任务的首条用户输入落盘后，Desktop 通过当前 Provider 的无状态 `LLMProvider.chat()` 辅助请求生成短标题，并以 `thread:state` 推送给 renderer。该调用不创建 Agent、session、Memory 或 tools；失败不阻塞主 run，且生成结果不得覆盖用户手动重命名。标题请求必须为推理型 Provider 预留足够的 completion budget；若应用在请求完成前退出，下次启动仅恢复“仍为默认标题且恰好一条用户输入”的任务，并串行执行恢复请求，避免 Provider burst。
- 切换会话不停止后台 run；关闭/删除会话会先 interrupt、拒绝未决审批，再 dispose。
- 成功完成的后台 run 在 Agent timeline 与 thread 状态落盘后触发通知。`ThreadRecord.unread/unreadAt` 与会话索引一起持久化，因此重启不会丢失未读状态。
- Renderer 通过 typed IPC 同步当前一至两个 active pane id，并在打开会话时显式 mark-read。窗口聚焦且完成任务位于任一 active pane 时不重复通知；窗口失焦或最小化时即使它是上次 active task，也会标记未读并走系统通知。
- 系统通知只展示经过控制字符清洗和截长的 task title 与 workspace name，不包含回答正文。通知实例在 click/close/failed 前由 main 保持引用；点击后聚焦（必要时重建）窗口并发送 typed thread-navigation request。系统通知不可用或发送失败时保留未读，非当前 pane 的提示在下次聚焦时降级为应用内通知。
- 窗口重新聚焦时，main 自动清除当前分屏内任务的未读，并通过 `thread:state` 把更新后的 `ThreadRecord` 同步给 renderer；非当前任务继续保留蓝点。

## Workspace 约束

Coding Agent 的 filesystem tool 必须绑定到 thread 的 workspace root，不能依赖 Electron 的全局 `process.cwd()`。路径解析必须拒绝 traversal 与 symlink escape。

Desktop Agent 禁用同步 built-in `bash`，使用 `SandboxPlugin` 的异步 `shell`。Local 模式明确标识为本地进程执行；Docker 才是更强隔离选项。

## 流式交互

Main 把 SDK 流转换为 versioned `AgentEventEnvelope`：run、model、reasoning、answer、tool、approval、final、failure 等事件都带 thread/session/run 关联信息。

每次 model call 是一个 phase：带 tool call 的 phase 属于 process；最后一个无 tool call 的 assistant phase 是 final answer。final 出现后，成功 run 的 process 默认折叠，但用户手动状态优先。失败、拒绝、取消和没有 final 的 run 保持展开。Process 内的每个工具步骤也独立默认收起，摘要行直接展示工具名与关键目标（路径、命令、URL 或查询）；展开后按工具语义展示文件内容、目录条目、搜索结果、stdout/stderr 等可读内容，仅对未知结构回退为格式化 JSON。

Final answer 在整条回复 hover/focus 时提供独立复制按钮，只复制最终结论的原始 Markdown。Markdown fenced code block 显示规范化语言名称，使用 renderer-only Shiki grammar 按需高亮，并在代码块 hover/focus 时提供只复制该代码块正文的按钮；复制成功后按钮短暂切换为绿色确认状态。

## ADE 布局

1. 左侧：workspace 与多会话管理、并行/审批状态、Evolution inbox、设置。
2. 中间：单会话或双会话可调宽分屏，会话流和 composer 各自独立。
3. 右侧：可选 workbench dock，包含带 Shiki 语法高亮预览的 Files、隔离 Browser 与 Terminal。

内置 Browser 使用隔离的 `WebContentsView`，不使用带 Node 权限的 webview/iframe。

Sidebar 的收起保留 DOM 结构并通过宽度、透明度和轻微位移渐进过渡；在 `prefers-reduced-motion` 下禁用动画。macOS titlebar 左侧控件为 traffic lights 保留安全间距；图标按钮的 pressed 状态只改变颜色或背景，不产生下沉位移。结构分割线使用低对比度边线、内侧高光和轻量阴影，不用重描边分割工作区。

用户消息气泡使用独立的明暗主题背景与低对比度内边线，和会话画布保持清晰区分；助手消息继续使用画布底色，不在整段回复外另加大面积卡片。

Workspace 行本身是展开/收起控制；hover 或键盘 focus 时显示只针对该目录的新任务按钮，点击按钮不改变分组状态。Sidebar titlebar 控件下方不画横线，使其与目录区域保持连续。后台任务成功完成后会持久化未读时间并显示蓝点：Walle 聚焦时对非可见 thread 使用站内通知，Walle 失焦或最小化时使用系统通知；打开目标 thread 后清除未读。通知只包含任务名与 workspace，不包含回答正文。

New thread 只在主区域打开未持久化的草稿，不立即向 sidebar 插入会话。草稿默认使用当前会话或所点 workspace 的目录；composer 顶栏可重新选择目录，未出现过的目录立即作为空 workspace 分组显示。首次发送才创建真实 thread，并用它替换当前 pane；离开未发送草稿不会留下空会话。草稿中的 `@` 文件搜索通过单独的 IPC 限定在已存在的 workspace 或本次文件夹选择器返回的 canonical 目录，图片附件仍在首次发送时按真实 thread id 保存。

Composer 的权限模式与 Settings 使用同一份持久化配置，可直接选择 Ask、自动批准或拒绝高风险。粘贴图片先在输入区上方预览；发送时 main 根据 thread id 将其原子保存到 workspace 的 `.walle/attachments`，timeline 只保存可读文件名/路径，校验后的图片字节仅作为本次 Provider 请求的瞬时 multimodal block，base64 不进入会话日志或压缩快照。`@` 文件搜索同样由 main 按 thread 绑定 workspace，跳过 symlink 与常见重量目录，选择结果在发送前展开为 canonical path。`/clear` 会在 idle 状态清空当前 UI/模型会话并生成新 session，`/compact` 调用并持久化 SDK 的 summary + recent-tail 压缩结果。

会话视口在用户主动向上滚动后停止自动追随流式输出，并在 composer 上方显示“回到最新消息”按钮；回到底部后恢复追随。两条及以上用户输入会在正文左缘显示独立的珠链式回合轨道，每个锚点可键盘访问、hover 查看摘要并平滑定位，split pane 各自维护滚动状态。流式 delta 只在仍处于 follow-tail 状态时即时对底，不能用连续 smooth scroll 把正在回看的用户强拉到底部。

Composer 工具栏中的上下文窗口指示器默认只显示圆环，hover/focus 后展示已用/剩余比例、token 数和数据口径。Provider 返回的单次 `model_call_end.usage` 作为“上次模型调用上下文”，不能复用一次 run 内多轮调用的累计计费 usage；缓存读取量和写入量随这次调用的 snapshot 落盘，缓存输入比例为读取 token 数除以该次调用的全部输入 token 数，Provider 未上报时显示不可用而不是 0%。Anthropic 的全部输入量包括未缓存输入、缓存读取与缓存写入；OpenAI 的输入量已包含缓存读取。`/compact` 后使用 `afterTokens` 并标为历史估算值，`/clear` 归零，估算值不展示旧调用的缓存数据。分母使用用户配置的 `maxContextTokens`，Desktop 默认 256,000；旧版默认的 128,000 在首次迁移时升级一次，之后用户主动设置的数值保持不变。UI 必须称其为 configured context budget，而不是声称它是 Provider 模型的硬上限。

Settings 与 Evolution inbox 都是主工作区中的独立页面而不是 modal。进入页面时保留 app titlebar/sidebar，并以覆盖层隐藏会话区；DeveloperDock 与 Terminal 保持挂载，避免页面导航终止交互式进程，原生 Browser view 则显式隐藏。从侧栏选择或新建会话会返回会话页面。Evolution inbox 按 Pending、Approved、Rejected、All 展示真实持久化状态，空态随筛选变化，提案卡片继续调用来源 thread 上的 approve-and-apply/reject 能力。

Files 预览在 renderer 内惰性加载 Shiki engine、主题和显式支持的语言 grammar。高亮结果以 token 数据交给 React 渲染，不插入 workspace 提供的 HTML；未知语言或 grammar 加载失败时回退为转义后的纯文本。异步请求必须遵守 latest-selection-wins，切文件或主题后旧结果不得覆盖新预览。

Composer 支持粘贴或选择 PNG/JPEG/WebP/GIF（最多 4 张、单张 5 MiB、合计 15 MiB），并在输入框上方展示可移除缩略图。该预算同时约束 raw bytes 与编码后请求体，避免 Anthropic 等 Provider 的单图/整包限制在 UI 接受后才失败。Renderer 只短暂持有 `File`、object URL 与发送前生成的 base64；成功、移除、切 thread 或卸载时必须 revoke object URL。Main 只接受 canonical base64 且 magic bytes 与 MIME 匹配的图片，通过 thread id 查找 canonical workspace，再以不可控随机名原子写入 `.walle/attachments/`；发送前以 no-follow file descriptor 限量重读并复验路径、inode、长度与 MIME。Provider 获得瞬时图片 block 和绝对路径提示，timeline 使用独立 display prompt 展示原始文字与附件名，任何持久化路径不得包含 base64。

在光标所在 token 输入 `@` 会触发 workspace 文件搜索。Main 从 thread id 解析 workspace，限制遍历深度、entries、时间和结果数，跳过 symlink、`.git`、`node_modules`、`.walle` 与生成目录。Renderer 必须用 request sequence 丢弃过期结果，并支持方向键、Enter、Escape、鼠标和 listbox a11y。选择结果会成为 Tiptap 的 inline atom 文件块，不能被当作普通字符拆开编辑；发送后的 user bubble 继续按持久化的有序 `text/file` parts 展示同类文件块，而不是裸 token。Timeline 不保存 Tiptap HTML/JSON，也不信任 renderer 传来的绝对路径；main 在发送时重新通过 workspace boundary 解析每个相对路径，再把 canonical path 编入模型 prompt。旧 timeline 没有 parts 时仍按纯文本回退。

Sidebar 搜索框以品牌行下方的浮层出现，不参与 flex 高度，因此不会把导航和 workspace 列表整体向下推。左下 Settings 始终是中性动作入口，不展示当前页选中态，只在 hover 时提高背景对比度。

Terminal 使用 renderer 内的 xterm.js 画布和 main 内的 `node-pty`，交互方式与 VS Code 集成终端一致：光标处直接输入，支持持续 cwd/history、Ctrl+C、IME、ANSI/TUI 与尺寸同步，不另设底部 command input。Renderer 创建终端时只提交 thread id 和字符尺寸；main 从 DesktopStore 解析 canonical workspace root，并按当前 Sandbox 设置启动 Local host shell 或带已配置 image/resource/network/workspace mount 的 Docker shell，Docker 启动失败不得静默回退到 host。直接由用户输入的交互式终端不经过 Agent tool approval 或 executable allowlist，UI 必须清晰披露该边界；Provider fallback credentials 不得继承给 PTY。PTY output 跨 IPC 前要合批并限制 pending 大小；每个 session 同时只能有一个带 sequence 的 batch in-flight，main 发出 batch 前暂停 PTY，renderer 必须等 xterm `write` callback 确认解析完成后 ACK，main 再发送 pending batch 或恢复 PTY。session 必须按 renderer owner/thread 校验，并在 dock/thread/window/reload/crash/quit 时清理，Docker container 还要显式兜底删除。

## 能力映射

| UI                          | Walle package / contract                        |
| --------------------------- | ----------------------------------------------- |
| Provider profiles           | `@walle-agent/openai`, `@walle-agent/anthropic` |
| Session history / memory    | `@walle-agent/memory`                           |
| Skills catalog              | `@walle-agent/skills`                           |
| Evolution inbox             | `@walle-agent/evolution`                        |
| Local/Docker execution      | `@walle-agent/sandbox`                          |
| MCP servers/tools           | `@walle-agent/mcp`                              |
| Knowledge directory         | `@walle-agent/rag`                              |
| Parallel/sub-agent profiles | `@walle-agent/team` + core `task`               |
| Traces                      | `@walle-agent/trace`                            |
| Permission approvals        | `@walle-agent/core` PermissionPolicy            |

完整产品要求、设计、任务与验证记录见 `plans/desktop-app/`。
