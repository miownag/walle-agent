# Walle Desktop — Testing

## Automated layers

### Unit

- DesktopStore creates defaults, round-trips data, writes atomically, and migrates old versions.
- Thread operations preserve session history and correctly handle pin/archive/delete.
- Timeline reducer groups phases and chooses only the final no-tool assistant message as the conclusion.
- Completed runs auto-collapse; failed/cancelled runs stay open; explicit user disclosure state wins.
- Provider profiles never expose plaintext secrets.
- Workspace path resolution rejects `..`, absolute outside paths, and symlink escapes.
- AgentManager rejects same-thread concurrency and permits cross-thread concurrency.

### SDK regression

- Existing core streaming consumers still receive `llm_chunk`.
- New `thinking_delta` events mirror the provider chunk exactly once.
- Workspace-bound filesystem tools preserve the legacy process-cwd behavior when no workspace root is configured.
- Existing package tests remain green.

### Renderer

- IPC event envelopes reduce into deterministic timeline state.
- Theme and density settings update the document root.
- Session search, split selection, dock visibility, and approval actions are keyboard reachable.
- Browser bounds are reported only while the Browser tab is visible.
- Sidebar collapse keeps a progressive width/content transition and honors reduced motion.
- Workspace groups expand/collapse accessibly, preserve disclosure across rerenders, and create a task in the exact workspace without toggling the group.
- Background completion persists a blue unread marker; selecting/viewing the thread clears it. Focused windows receive an in-app notice, while unfocused/minimized windows request a system notification.
- Titlebar controls keep a traffic-light-safe leading gutter, and icon buttons have no pressed translate/scale motion.
- Settings renders as an in-app page; entering it hides BrowserView, and selecting or creating a thread returns to conversation.
- Evolution inbox renders as an in-app page with status counts, filter-specific empty states, and proposal cards; approve/reject actions retain their proposal identity, and returning/selecting a thread restores the conversation page.
- Checked Switch hover preserves its selected color while unchecked hover gains contrast.
- File preview maps known file types to Shiki grammars, follows the active theme, ignores stale async results, and safely falls back to plain text.
- Terminal starts only when its dock tab is activated, buffers create-handshake input/output, forwards resize/clear, stops stale input after exit, and closes on dock/thread unmount.
- Main validates terminal owner/id/input/size/ACK sequence, canonicalizes cwd, does not inherit Provider keys or parent-terminal metadata, caps/batches output, permits only one in-flight batch until xterm ACK, and cleans PTYs/containers on thread, renderer, window, and app lifecycle events.
- Composer approval selection updates persisted settings; pasted images preview/remove safely and survive send failure; object URLs are revoked.
- `@` search is thread/workspace scoped, bounded, skips symlinks and ignored directories, and rejects stale responses. Selection inserts a Tiptap atom; send preserves ordered semantic parts, main re-resolves canonical paths, failure retains the draft, and legacy plain messages still render.
- Sidebar search overlays rather than shifting navigation/workspace rows; Escape closes it and clears filtering. Settings never gains selected-page styling and darkens only on hover.
- `/clear` replaces session/timeline only while idle; `/compact` persists summary-plus-tail history and reports no-op/error states without starting a normal run.

## Manual smoke matrix

1. Launch without credentials; create a workspace/session; open Settings.
2. Save and switch OpenAI, OpenAI-compatible, and Anthropic profiles.
3. Run a coding task that reads, edits, and searches files.
4. Allow once, always allow, and deny a tool approval.
5. Stop a streaming task and resume the session.
6. Run two sessions concurrently and open both in split view.
7. Restart; verify sessions, timelines, theme, split layout, and dock state restore.
8. Inspect a highlighted file, navigate the built-in browser, and use the integrated terminal.
9. Enable Skills and Evolution; review a proposal in the inbox.
10. Switch Local/Docker modes and verify the UI describes their actual boundaries.
11. In Terminal, verify `pwd`, `cd` persistence, shell history, Ctrl+C on a long process, resize, clear/restart, ANSI output, and a full-screen TUI; repeat in Docker without host fallback.
12. Run a task in a non-selected workspace thread, verify the in-app notice and blue dot, then repeat with Walle unfocused and verify the system-notification path and click-to-open behavior.
13. Paste/remove/send multiple images, select files with `@`, verify atomic chips in the draft and sent bubble, inspect the final expanded prompt paths, then execute `/compact` and `/clear` from the slash menu.

## Commands

```bash
pnpm install
pnpm --filter @walle-agent/core test
pnpm --filter @walle-agent/desktop typecheck
pnpm --filter @walle-agent/desktop test
pnpm test
pnpm build
# Optional only; not required for the current local-dev scope:
pnpm --filter @walle-agent/desktop package:mac
```

## Visual QA targets

- 1440×900 and 1728×1000 at default macOS scale.
- Sidebar expanded/collapsed; dock hidden/open; one/two session panes.
- Workspace group hover/focus action, disclosure states, and background-task unread dots.
- Settings and Evolution inbox as full workspace pages, including sidebar navigation, proposal filters/actions, and Switch hover states.
- Light, dark, and system themes.
- Shiki-highlighted source preview in light and dark themes, plus an unknown-file fallback.
- Integrated terminal with inline prompt/cursor (no separate command field): `pwd`, persistent `cd`, shell history, ANSI color, Ctrl+C, resize, restart, and cleanup.
- Empty, running, waiting approval, completed, cancelled, and error timelines.
- Long Markdown, code blocks, large tool output, narrow panes, and reduced motion.
