# Built-in `web_fetch` — Requirements

## Why this slice

Walle agents already have local-only "world access" — filesystem, shell, plan/todo,
sub-agent dispatch — but no first-party way to read a public web page. Users who
want documentation lookup, news scraping, or arbitrary URL capture have to roll
their own tool or pull in an MCP server.

Claude Code ships a **WebFetch** tool that:

1. Takes `{ url, prompt }`.
2. Fetches the URL, converts HTML → Markdown.
3. Asks a small fast model to answer `prompt` against the cleaned content.
4. Caches the answer for ~15 minutes.
5. Auto-upgrades `http://` → `https://`.
6. Reports cross-host redirects without following them.

Replicating that contract in `@walle-agent/core` keeps the SDK's built-in
toolset roughly equivalent to Claude Code's, with no extra dependency and no
plugin install required.

## Functional requirements

### F1 — Tool surface

- Name: `web_fetch`.
- Input:
  ```ts
  {
    url: string;        // fully-qualified; http:// auto-upgraded to https://
    prompt: string;     // forwarded to the summariser LLM as the user prompt
    timeout?: number;   // ms, default 30_000
  }
  ```
- Success output:
  ```ts
  {
    url: string;            // the original argument
    finalUrl: string;       // post-upgrade / post-same-host-redirect URL
    status: number;
    contentType?: string;
    content: string;        // LLM answer to `prompt`
    truncated: boolean;
    cached?: boolean;       // present and `true` when served from the cache
  }
  ```
- Cross-host redirect output (returned, not followed):
  ```ts
  {
    url: string;
    redirectTo: string;
    redirectHost: string;
    status: number;
    message: string;
  }
  ```
- Error output:
  ```ts
  { error: string; url?: string; status?: number }
  ```

### F2 — HTTP behaviour

- `redirect: "manual"` — we drive redirect handling ourselves.
- Same-host redirect: follow up to 5 hops, then fail.
- Cross-host redirect: return structured payload so the LLM can re-issue.
- Default timeout 30s, configurable per call.
- Default User-Agent: `Walle/1.0 (+https://github.com/walle-agent)`.

### F3 — Body processing

- HTML / XML → markdown via zero-dep `htmlToMarkdown` (drop `<script>`, `<style>`,
  `<noscript>`, `<template>`, `<svg>`, `<head>` except `<title>`; convert headings,
  links, images, lists, code, blockquote; decode HTML entities; collapse whitespace).
- JSON → pretty-printed JSON code-fence.
- Anything else → raw text.
- Truncate to `maxContentChars` (default 100_000) before sending to the model.

### F4 — Summarisation

- Use the agent's main `LLMProvider` (overridable in factory options).
- Single-shot `chat()` call with a fixed system prompt + one user message that
  contains the URL, content type, prompt, and (truncated) page markdown.
- LLM answer text is the tool's `content` field.

### F5 — Cache

- In-memory `Map`, key = `(model.name, finalUrl, prompt)`, TTL 15 min.
- Lazy expiry on read.
- Exported `clearWebFetchCache()` for tests / disposal.

### F6 — AgentRuntime wiring

- Per-agent factory `createWebFetchTool({ model, … })` — like `task` and
  `tool_search`, NOT a module-level singleton (it needs the model handle).
- `AgentRuntime.init()` registers it after `task` and before
  `applyToolSearchPolicy()`.
- Honours `useBuiltinTools.{includeTools, excludeTools}` exactly like other
  built-ins.
- Skipped silently if `globalThis.fetch` is unavailable (older Node, custom
  runtime) — startup never crashes for environment reasons.
- Tagged `["builtin", "web"]` so the tool-search policy keeps it active.

### F7 — Permission / risk

- `riskLevel: "medium"` — outbound network call against an arbitrary URL.
- `requiresApproval` not set; rely on the host's permission policy if the
  user wants to gate it.

## Non-functional requirements

- **Zero new runtime deps**: HTML → markdown is pure TS.
- **Test coverage**: input validation, protocol upgrade, cross-host redirect,
  same-host redirect chase, HTTP error, model wiring, cache hit, truncation,
  JSON pretty-print, summariser failure path, htmlToMarkdown unit tests.
- **No regression**: full `pnpm test` stays green (54 files, 448 tests
  before this change).

## Out of scope (deferred)

- Authenticated fetches / cookies / OAuth — use a dedicated MCP server.
- POST / PUT / non-GET methods.
- Cross-host redirect auto-follow with allow-list — caller decides.
- Streaming response bodies.
- robots.txt enforcement.
- Caching to disk via `MemoryPlugin` — current in-memory cache is enough
  for a single agent process; cross-process cache is a v2 idea.
