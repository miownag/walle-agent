# Walle Desktop — Tasks

## Foundation

- [x] Add `apps/*` to the pnpm workspace and scaffold `apps/desktop`.
- [x] Configure Electron, React 19, Vite/electron-vite, Tailwind CSS v4, latest shadcn/ui source components, and Tabler React icons.
- [x] Add strict node/preload and renderer TypeScript projects.
- [x] Add desktop scripts for dev, typecheck, test, build, and optional mac packaging.
- [x] Add root scripts/configuration needed to include the app in verification.

## SDK contracts

- [x] Add a first-class `thinking_delta` Agent stream event while preserving existing `llm_chunk` compatibility.
- [x] Add per-Agent workspace-root support for bounded filesystem built-ins.
- [x] Add path-bound filesystem tool factories and tests for traversal/symlink protection.
- [x] Keep desktop shell execution asynchronous by excluding built-in `bash`.

## Main process

- [x] Implement safe window creation and lifecycle.
- [x] Implement versioned DesktopStore, thread index, timeline persistence, and migrations.
- [x] Implement Provider profile storage with safeStorage-backed secrets.
- [x] Implement AgentManager with one Agent per thread and cross-thread concurrency.
- [x] Implement stream normalization, final-answer grouping, cancellation, and ApprovalBroker.
- [x] Wire Memory, Skills, Evolution, Sandbox, RAG, MCP, Team, Trace, compression, and tool-search settings.
- [x] Implement workspace tree/read/search/command IPC.
- [x] Implement BrowserManager with WebContentsView bounds and navigation.

## Preload and shared contracts

- [x] Define JSON-safe schemas and TypeScript DTOs.
- [x] Expose the minimal `window.walle` contextBridge API.
- [x] Validate IPC payloads and clean up event subscriptions.

## Renderer

- [x] Implement theme bootstrap and appearance persistence.
- [x] Implement macOS titlebar, session sidebar, resizable layout, workbench dock, and split panes.
- [x] Implement empty workspace state and composer.
- [x] Implement conversation reducer and persisted timeline hydration.
- [x] Implement live reasoning, tool steps, inline approvals, failures, final answer, and disclosure rules.
- [x] Implement file tree/preview, browser toolbar/view, and lightweight sandbox terminal.
- [x] Implement settings for General, Appearance, Providers, Sandbox & Permissions, Skills, MCP, Memory/RAG, Evolution, Team, Trace/Context, and About.
- [x] Implement Evolution inbox and capability/status views.
- [x] Add progressive sidebar collapse motion, larger non-directional panel icons, and low-contrast shadowed dividers.
- [x] Increase the macOS traffic-light gutter and remove pressed-position motion from icon buttons.
- [x] Add collapsible workspace rows with a hover/focus new-task action and remove the divider below the sidebar titlebar control.
- [x] Add persisted unread completion markers plus focused in-app and unfocused system notifications.
- [x] Move Settings from a dialog into the main app workspace and preserve safe BrowserView teardown/navigation behavior.
- [x] Correct checked/unchecked Switch hover semantics in both themes.
- [x] Add theme-aware, lazy Shiki syntax highlighting to Files preview with safe plain-text fallback and stale-result protection.
- [x] Replace the one-shot command form with an xterm/node-pty interactive terminal, including Local/Docker lifecycle management, typed IPC, resize, ACK-based backpressure, and cleanup.
- [x] Make the composer approval mode selectable and synchronized with Settings.
- [x] Add bounded pasted-image previews plus workspace-local attachment persistence.
- [x] Add keyboard-accessible `@` workspace file search with canonical-path prompt expansion.
- [x] Add `/clear` and `/compact` command discovery plus runtime IPC and persisted compaction.
- [x] Make sidebar search non-layout-shifting and keep Settings neutral with a stronger hover state.
- [x] Move Evolution Inbox into a filtered, full-workspace review page.
- [x] Render `@` file references as Tiptap inline atoms and persist ordered semantic message parts.

## Verification

- [x] Add unit tests for store migration, event reduction, disclosure behavior, path bounds, and settings normalization.
- [x] Add Electron smoke coverage for preload availability and secure webPreferences.
- [x] Run SDK and desktop tests, typecheck, and production build.
- [x] Launch the app and visually inspect themes, empty state, settings, split, Provider menu, and workbench; cover running/completed/approval disclosure states in reducer tests.
- [x] Start `desktop:dev` successfully; macOS artifact explicitly excluded from final scope by the user.
- [x] Persist completed-run unread state and expose typed active-pane/mark-read IPC.
- [x] Route focused background completions to in-app attention and unfocused completions to safe Electron notifications.
- [x] Focus and navigate from system-notification clicks, with notification-failure fallback and focus-time unread reconciliation.
- [x] Add secure pasted-image attachments with workspace-local atomic storage and draft-preserving send failures.
- [x] Add bounded, symlink-safe `@` workspace file search with keyboard/mouse selection and absolute-path prompt expansion.
