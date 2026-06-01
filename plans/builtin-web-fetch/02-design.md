# Built-in `web_fetch` — Design

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ @walle-agent/core                                                        │
│                                                                          │
│  builtin-tools/                                                          │
│   ├── web-fetch-tool.ts          ← new                                   │
│   │    createWebFetchTool({ model, … })                                  │
│   │    htmlToMarkdown(html)        (exported helper / testable)          │
│   │    clearWebFetchCache()        (test / disposal helper)              │
│   └── index.ts (update — export factory + helpers; web_fetch is NOT in   │
│                BUILTIN_TOOLS, like `task` and `tool_search`)             │
│                                                                          │
│  agent-runtime.ts (update)                                               │
│   init():                                                                │
│     ... existing built-in registration ...                               │
│     registerTaskTool();                                                  │
│     registerWebFetchTool();        ← NEW                                 │
│     applyToolSearchPolicy();                                             │
└──────────────────────────────────────────────────────────────────────────┘
```

## Module layout

```
packages/core/src/
└── builtin-tools/
    ├── web-fetch-tool.ts        new — factory + html→md + cache
    └── index.ts                 update — export helpers
packages/core/src/
├── agent-runtime.ts             update — registerWebFetchTool() in init()
└── index.ts                     update — re-export public API
packages/core/tests/
└── web-fetch-tool.test.ts       new — 16 unit tests
plans/builtin-web-fetch/         new — this plan
```

## Lifecycle

```
Agent.create
  └─ AgentRuntime.init
       1. registerBuiltinTools()        // BUILTIN_TOOLS array
       2. register native tools
       3. shorthand hooks/middleware
       4. plugin.install loop
       5. registerTaskTool()            // per-agent — needs subAgentRegistry
       6. registerWebFetchTool()        // per-agent — needs config.model
       7. applyToolSearchPolicy()       // shadow MCP, register search/defer
```

`registerWebFetchTool` is tagged `["builtin", "web"]`, so the default
`alwaysActiveTags: ["builtin"]` keeps it visible even when shadow kicks in.

## Tool flow

```
LLM tool call: web_fetch({ url, prompt, timeout? })
  │
  ├─ validate → normalise (http→https) → URL.parse → protocol check
  │
  ├─ cache lookup: (model.name, requestUrl, prompt) → 15-min TTL
  │   ↳ hit: return { ...cached, cached: true }
  │
  ├─ fetchOnce(targetUrl, …, redirectsLeft = 5):
  │     fetch(target, { redirect: "manual", User-Agent, Accept, Accept-Language })
  │     ↳ 3xx + Location:
  │        cross-host  → return { redirectTo, redirectHost, message }
  │        same-host   → fetchOnce(absolute, …, redirectsLeft - 1)
  │     ↳ !ok           → { error, status }
  │     ↳ 2xx:
  │        body = response.text()
  │        cleaned = htmlToMarkdown | JSON.pretty | raw
  │        if cleaned.length > maxContentChars: truncate, mark `truncated: true`
  │        ask model: chat([system, user(URL + Prompt + cleaned)])
  │        return { url, finalUrl, status, contentType, content, truncated }
  │
  └─ cache store on success → return
```

## Cache key

```
key = `${model.name} ${finalUrl} ${prompt}`
```

Including `model.name` keeps differently-modeled agents from sharing answers
that may not actually be equivalent. Same-prompt-different-model is a
deliberate cache miss.

## HTML → Markdown

Implemented as a sequence of `String.replace` passes. Strategy:

| Region | Treatment |
|---|---|
| `<title>` | Captured first → emitted as `# {title}` at top |
| `<script>`, `<style>`, `<noscript>`, `<template>`, `<svg>`, `<head>` | dropped wholesale |
| `<!-- comments -->` | dropped |
| `<h1>..<h6>` | `# ..######` |
| `<a href="…">text</a>` | `[text](href)` |
| `<img src="…" alt="…">` | `![alt](src)` |
| `<code>` | `` `…` `` |
| `<pre>` | fenced ``` block |
| `<li>` | `- …` |
| `<ul>/<ol>` | dropped (markers come from `<li>`) |
| `<blockquote>` | `> …` lines |
| `<hr>` | `---` |
| `<br>`, `</p>`, `</div>`, `</tr>` … | newlines |
| Everything else | tag stripped |
| Numeric / named entities | decoded |
| Whitespace | runs collapsed; ≥3 newlines → 2 |

Not a full HTML parser — but enough for an LLM to understand the page.

## Wiring snippets

```ts
// agent-runtime.ts (excerpt)
private registerWebFetchTool(): void {
  const config = this.config.useBuiltinTools;
  if (config === false) return;
  if (typeof config === "object") {
    if (config.includeTools && config.includeTools.length > 0) {
      if (!config.includeTools.includes(WEB_FETCH_NAME)) return;
    } else if (config.excludeTools && config.excludeTools.includes(WEB_FETCH_NAME)) {
      return;
    }
  }
  if (this.toolRegistry.has(WEB_FETCH_NAME)) return;       // user override wins
  if (typeof globalThis.fetch !== "function") return;       // skip on Node 18-

  try {
    this.toolRegistry.register(
      createWebFetchTool({ model: this.config.model }),
    );
  } catch {
    // createWebFetchTool only throws when fetch is missing — we already guarded.
  }
}
```

## Public API

```ts
// @walle-agent/core
export {
  createWebFetchTool,
  WEB_FETCH_NAME,
  htmlToMarkdown,
  clearWebFetchCache,
} from "./builtin-tools/web-fetch-tool.js";
export type {
  WebFetchInput,
  WebFetchOutput,
  WebFetchSuccessOutput,
  WebFetchRedirectOutput,
  WebFetchErrorOutput,
  CreateWebFetchOptions,
} from "./builtin-tools/web-fetch-tool.js";
```

## Edge cases

| Case | Behaviour |
|---|---|
| `url: ""` / `prompt: ""` | `{ error: "web_fetch: 'url|prompt' is required" }` |
| `url: "ftp://…"` | `{ error: "unsupported protocol" }` |
| Invalid URL string | `{ error: "invalid URL" }` |
| `http://` URL | upgraded to `https://` — `finalUrl` reflects that |
| Cross-host redirect | structured `{ redirectTo, redirectHost, message }` |
| Same-host redirect | followed (up to 5 hops) |
| > 5 same-host hops | `{ error: "too many redirects" }` |
| HTTP 4xx/5xx | `{ error: "HTTP NNN", status }` |
| `body.length > maxContentChars` | truncated; `truncated: true` |
| LLM `chat()` throws | `{ error: "LLM summarisation failed: …" }` |
| `globalThis.fetch` unavailable | tool not registered (silent) |
| User-supplied `tools: [{ name: "web_fetch" }]` | user tool wins |
| `useBuiltinTools: { excludeTools: ["web_fetch"] }` | not registered |

## Backward compat

Adding the tool only changes behaviour when the LLM elects to call it.
Existing agents and tests are unaffected — the 30-tool `tool_search`
threshold means small projects don't auto-shadow even with the new tool.
