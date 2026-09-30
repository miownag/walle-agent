# Walle Desktop — Design

## Workspace placement

The private application lives at `apps/desktop` with package name `@walle-agent/desktop`. SDK packages remain publishable libraries under `packages/*`.

## Process architecture

```text
Renderer (React + shadcn/ui)
  | typed, JSON-safe window.walle API
Preload (contextBridge)
  | validated IPC invoke + one event stream
Electron main
  |-- DesktopStore (settings, thread index, UI timelines)
  |-- AgentManager (one AgentHandle per thread)
  |-- ApprovalBroker (Promise <-> inline UI decision)
  |-- WorkspaceService (bounded files and command execution)
  |-- BrowserManager (isolated WebContentsView)
  `-- Walle SDK packages and local plugins
```

The renderer is intentionally a projection of local state. It cannot import SDK classes, read arbitrary files, spawn processes, or access credentials.

## App shell

```text
MacTitlebar (48px, hiddenInset)
Resizable horizontal layout
  ProjectSidebar (276px default, 240..360, collapsible)
  SessionSplitArea (one-to-three panes, each >= 480px)
    ThreadHeader (44px)
    ConversationViewport (transcript max width 820px)
    Composer (max width 736px, bottom 16px)
  WorkbenchDock (520px default, 360..840, optional)
    Files / Changes / Preview / Browser / Terminal
```

The dock is hidden on an empty task. File/tool actions open it intentionally; completed runs do not steal focus.

Workspace rows in the sidebar are disclosure controls. Hover or keyboard focus reveals a scoped new-task button without changing the disclosure state. The macOS titlebar divider begins at the conversation canvas, leaving the sidebar control cell visually continuous with the sidebar.

New thread opens a renderer-only draft in the conversation area. It inherits the selected thread or workspace row's root, permits changing the root from the composer, and exposes an empty sidebar workspace group for a newly picked directory. The thread is persisted only on first submission; leaving an unsent draft creates no thread. Draft file search accepts only roots already attached to a thread or canonical roots returned by the native folder picker in the current main-process lifetime.

Settings and Evolution inbox are first-class workspace pages, not modal layers. Opening either preserves the app titlebar and project sidebar, removes conversation-only split/dock controls, hides the native Browser view, and marks no conversation pane as visible. Evolution provides explicit Pending, Approved, Rejected, and All filters; proposal cards expose the persisted proposal status and keep approve-and-apply/reject actions wired to the originating thread.

## Thread and timeline storage

`MemoryPlugin` remains the model-history source. Desktop adds its own atomic JSON stores under Electron `userData/walle`:

```ts
interface ThreadRecord {
  id: string;
  sessionId: string;
  title: string;
  workspaceRoot: string;
  providerProfileId: string;
  model: string;
  pinned: boolean;
  archived: boolean;
  unreadAt?: string;
  createdAt: string;
  updatedAt: string;
  lastMessage?: string;
}
```

Each thread also owns a versioned UI timeline. The timeline stores user prompts, normalized process steps, final answers, status, and user disclosure preference. Writes use a temporary file plus rename.

Renderer synchronizes the visible conversation pane ids to main. A successful completion is considered observed only while the Walle window is focused and that thread is in a visible pane. Other completions persist `unreadAt`; main emits an in-app notice when Walle is focused and uses Electron's system notification when it is not. Selecting the thread, returning focus to an already-visible thread, or clicking its system notification clears the marker. Notification text contains task/workspace metadata, never answer content.

## Composer context and commands

The composer owns draft-only image previews and file-mention display tokens. Image paste data is bounded to four images, 5 MiB each and 15 MiB total in renderer, then sent through typed IPC only when submitting; main resolves the thread's canonical workspace and atomically stores generated files under `.walle/attachments` without accepting a renderer-provided destination. Conversation persistence receives only readable names/paths. Main reopens the saved files with no-follow, descriptor, byte-count, MIME, and workspace checks and passes the verified bytes as transient multimodal input; compaction and trace persistence must strip image blocks/base64.

The context meter compares the latest model call with the configured budget, now 256,000 tokens by default. It persists provider-reported cache read/write counts with the same call snapshot and displays cached input as a share of total input tokens. Missing cache fields are reported as unavailable rather than zero. Legacy 128,000-token defaults migrate once; subsequent user changes remain authoritative.

Typing `@` performs a bounded, symlink-skipping file search scoped by thread id. The composer uses a minimal Tiptap document (paragraph, text, hard break, undo/redo, placeholder, and an inline atomic `fileReference` node) so a selected file is a single accessible chip rather than editable token text. The durable timeline stores ordered `UserMessagePart[]` text/file semantics, never Tiptap HTML or JSON; legacy messages retain the plain `content` fallback. Main validates the typed parts, re-resolves every relative file through the workspace boundary at send time, and compiles canonical paths into the Agent prompt. The approval selector updates the same persisted permission mode used by Settings.

Typing `/` opens a keyboard-accessible command list. `/clear` disposes the idle thread runtime, moves the thread to a fresh session, clears its UI timeline, and removes the old session log without erasing workspace files or long-term memory. `/compact` calls `Agent.compact()` and persists the resulting summary-plus-tail history before returning compression statistics.

## Normalized event contract

All SDK events are adapted in main before crossing IPC:

```ts
interface AgentEventEnvelope {
  version: 1;
  sequence: number;
  timestamp: string;
  threadId: string;
  sessionId: string;
  runId: string;
  turn?: number;
  type:
    | "run.started"
    | "model.started"
    | "reasoning.delta"
    | "answer.delta"
    | "tool.started"
    | "tool.completed"
    | "approval.requested"
    | "approval.resolved"
    | "assistant.completed"
    | "evolution.proposal"
    | "run.completed"
    | "run.cancelled"
    | "run.failed";
  payload: unknown;
}
```

The adapter reads first-class thinking events when available and supports the current `llm_chunk.thinking_delta` shape during migration.

## Final-answer grouping

- `model_call_start` begins a phase.
- thinking deltas append to the phase reasoning block.
- text deltas append to the phase assistant draft.
- a model message with tool calls remains part of the process disclosure.
- the last model message without tool calls is the final answer.
- completed + final: auto-collapse process unless the user explicitly changed it.
- failed, denied, cancelled, or no-final: keep process expanded.

`AgentResult.content` is not used as the final-answer source because it concatenates deltas from multiple model turns.

## Agent manager

`AgentManager` maintains `Map<threadId, AgentHandle>`. An `AgentHandle` retains the Agent and the plugin instances needed by settings and management views. The plugin order is:

1. Memory
2. Skills
3. Evolution
4. Sandbox
5. RAG
6. MCP
7. Trace

A thread may have one active run. Different handles run concurrently. Updating a runtime-affecting setting disposes and lazily recreates the relevant handle without deleting session history.

## Workspace safety

Core receives a per-Agent workspace root for workspace-bound filesystem tools. Path resolution checks the real workspace root and real parent/target path to reject traversal and symlink escapes. Desktop excludes built-in `bash` and uses `SandboxPlugin`'s asynchronous shell tool with the selected workspace as cwd.

Local sandbox is labelled **Local process** rather than fully isolated. Docker mode exposes image, memory, CPU, mount, and network settings.

## Provider and secret storage

Provider profile metadata is JSON. API keys are encrypted with Electron `safeStorage` when available; the renderer only receives `hasApiKey` and a masked hint. Environment variables remain a supported zero-write fallback.

Supported factories:

- OpenAI
- OpenAI-compatible (`baseURL`)
- Anthropic

The settings surface is extensible so later Provider packages can register schemas.

## Browser

The browser uses an Electron `WebContentsView` attached to the main window. Renderer reports the content rectangle through IPC. Browser partitions are ephemeral by default, Node integration is disabled, window creation is denied, permission requests are denied unless explicitly supported, and external-open is a separate user action.

## Terminal

The workbench terminal uses `@xterm/xterm` plus `@xterm/addon-fit` in the renderer and `node-pty` in Electron main. Typed IPC carries create/input/resize/clear/close and batched data/exit events; the renderer never imports Node APIs or the PTY binding. Create accepts a thread id instead of an arbitrary cwd so main resolves the canonical workspace root from DesktopStore. Local mode launches the user's host shell; Docker mode launches a uniquely named `docker run --rm -it` with the configured image, resource/network limits, and workspace mount, with explicit container cleanup and no host fallback.

Terminal sessions are owner- and thread-scoped. Output is batched at roughly one frame and pending data is capped before IPC. A sequence/ACK credit protocol permits only one in-flight batch: main pauses the PTY before delivery, renderer ACKs from xterm's parsed-write callback, then main sends one pending batch or resumes the PTY. Dock/thread unmount, renderer navigation/crash, window close, thread deletion, and app quit dispose their PTYs. Direct terminal keystrokes are a user shell action rather than an Agent tool call, so Agent approvals and executable allowlists do not intercept them; the UI labels this boundary and main removes Provider fallback credentials and inherited parent-terminal metadata from the PTY environment.

## Visual system

- macOS titlebar: 48px, hidden inset traffic lights.
- Sidebar: 276px, rows 32px, selection without border.
- Base font: system UI 13px/1.45; Markdown 14.5px/1.65; code 12.5px.
- Icons: `@tabler/icons-react`, normally 16px with stroke 1.6.
- Light canvas: `#fafafa`; dark canvas: `#18191c`.
- Accent: Walle amber `#e4a13a`, kept separate from the neutral primary action color.
- Shadows appear only on the composer and transient overlays.
- Motion respects `prefers-reduced-motion`.

Sidebar search is an anchored overlay below the brand row, so opening it never changes the vertical position of navigation or workspace groups. The Settings footer action has no selected/current-page treatment and only gains contrast on hover.

The latest shadcn/ui source components are generated with Tailwind CSS v4, React 19, the Base UI foundation, and the Tabler icon library configuration.
