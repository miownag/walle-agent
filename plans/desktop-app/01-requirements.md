# Walle Desktop — Requirements

## Goal

Build a local-only, macOS-first coding Agent desktop application named **Walle** inside the Walle Agent monorepo. The application must use the existing SDK as its runtime instead of duplicating Agent behavior in the renderer.

## Product principles

1. **Local by default** — conversations, traces, skills, memories, settings, and API credentials remain on the machine. There is no Walle cloud account.
2. **Coding workspace first** — every task is attached to an explicit workspace root. File and shell capabilities must never depend on Electron's process cwd.
3. **Progress without overload** — reasoning and execution are visible while a run is active. Once a final answer exists, earlier process groups collapse automatically and remain manually inspectable.
4. **Parallel but isolated** — one Agent instance owns one session. A session runs serially; different sessions can run concurrently and can be shown side-by-side.
5. **Capabilities are inspectable** — Provider, permissions, sandbox, Skills, MCP, Memory/RAG, Evolution, Team, Trace, and context settings are available from the UI and have clear local-state indicators.

## P0 user journeys

### First launch

- Choose a local workspace.
- Configure an OpenAI, OpenAI-compatible, or Anthropic Provider.
- Choose Local or Docker sandbox mode and a permission preset.
- Understand that Local mode is process isolation only, while Docker is the stronger boundary.

### Sessions

- Create, search, rename, pin, archive, restore, and delete sessions.
- Group sessions by workspace and restore them after restart.
- Expand or collapse each workspace group and create a task directly from its hover/focus action.
- Run tasks in two or more sessions concurrently.
- Open another session in a split pane without interrupting either run.
- Cancel an active run and resume the session later.
- When a background task completes, show an in-app notice while Walle is focused or a system notification while it is not; keep a blue unread marker until that task is viewed.

### Conversation

- Stream reasoning, assistant text, tool calls, approvals, failures, and the final answer.
- Keep the live process expanded.
- When a final answer arrives, collapse the completed process by default.
- Preserve an explicit user expand/collapse choice per run.
- Keep failed, denied, cancelled, or timed-out processes expanded.
- Render Markdown, code blocks, file references, and tool output safely.
- Select the current approval mode directly from the composer.
- Paste local images into the composer, preview/remove them before send, persist workspace-local paths, and send verified image bytes only as transient multimodal input rather than embedding base64 in conversation storage.
- Type `@` to search workspace files; selected references render as atomic file chips in both the editor and sent message, while main resolves their relative paths to canonical workspace files for the Agent prompt.
- Type `/` to discover commands; `/clear` starts the task with a fresh context and `/compact` actively summarizes older context.

### ADE workbench

- Use a resizable three-zone layout: project/session sidebar, one-to-three session panes, and an optional workbench dock.
- Browse the workspace tree and read text files.
- Open tool-referenced files and line locations.
- Use a built-in browser with back, forward, reload, address entry, and external-open actions.
- Keep browser content in an isolated Electron WebContentsView with no Node access.
- Provide a VS Code-style interactive terminal with cursor input, persistent shell state, ANSI/TUI support, and workspace-bound Local/Docker PTY execution.

### Runtime and settings

- Store Provider secrets with Electron safeStorage and never return plaintext secrets to the renderer.
- Switch light, dark, or system appearance; configure density and editor typography.
- Configure permission mode and resolve tool approvals inline.
- Enable or disable Memory, Skills, Evolution, RAG, MCP, Team/sub-agents, Trace, tool search, and context compression.
- Review and approve or reject Evolution proposals.
- Inspect installed Skills, visible tools, MCP servers, and runtime health.

## P1 follow-ups

- Monaco editor and rich diff/changes review.
- Multiple named terminals, persisted terminal layouts, and shell profile selection.
- Git/worktree management and pull-request workflows.
- Durable Provider-side image uploads/file IDs and cross-turn remote attachment reuse.
- Windows/Linux polish, auto-update, signing, and notarization.
- Streamed sub-agent internals for `AgentTeam` and dynamic `task` children.

## Security requirements

- Electron renderer uses `nodeIntegration: false`, `contextIsolation: true`, and a narrow typed preload API.
- SDK packages, Provider keys, filesystem APIs, subprocesses, MCP clients, and Evolution stores run only in the main process (or a later utility process).
- A workspace-bound tool layer rejects paths outside the workspace root, including traversal and symlink escapes.
- Built-in synchronous `bash` is disabled in desktop Agents. Shell work uses the asynchronous Sandbox plugin and explicit approval.
- Navigation denies popups by default and opens explicitly requested external URLs through the OS.
- Closing a window or cancelling a run denies unresolved approvals.

## Acceptance criteria

- A clean checkout can install, typecheck, test, build, and launch the desktop workspace with pnpm.
- The app starts without a Provider key and presents a usable local setup state.
- With a valid Provider profile, a task streams into structured process groups and a distinct final answer.
- Two sessions can run in parallel; starting a second run in the same session is rejected in the UI.
- Session metadata and timelines survive app restart.
- Workspace disclosure state remains stable while the sidebar is mounted, and unread completion state survives restart until viewed.
- Composer attachments, file mentions, approval selection, and slash commands remain renderer-safe and use typed, workspace-bound IPC.
- Sidebar search opens without shifting the navigation/session layout; Settings remains a neutral action rather than a selected navigation destination.
- File reads/writes and shell commands are scoped to the selected workspace.
- Light/dark/system themes and appearance settings persist.
- The packaged renderer never imports Node or Walle SDK modules directly.
