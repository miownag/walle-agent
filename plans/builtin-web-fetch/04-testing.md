# Built-in `web_fetch` — Testing

## Test plan

```bash
pnpm exec vitest run packages/core/tests/web-fetch-tool.test.ts
pnpm test
```

## Coverage

`packages/core/tests/web-fetch-tool.test.ts` — 16 cases, all green.

### `htmlToMarkdown` (4 tests)

| # | Case | Assertion |
|---|---|---|
| 1 | Page with `<title>` | Output begins with `# Hello` |
| 2 | Page with `<script>` and `<style>` | Output drops both, keeps the visible `<p>` |
| 3 | Headings + link + list | `## Section`, `[docs](https://example.com)`, `- One`, `- Two` |
| 4 | HTML entities | `&lt;`, `&amp;` decode correctly |

### `createWebFetchTool` (12 tests)

| # | Case | Assertion |
|---|---|---|
| 1 | Tool name + tags + required params | `name === "web_fetch"`, tags include `"builtin"`, required `["url","prompt"]` |
| 2 | Empty url | Error mentions `url` |
| 2 | Empty prompt | Error mentions `prompt` |
| 3 | `ftp://` url | Error mentions `protocol` |
| 4 | `http://example.com/page` | Auto-upgraded; `finalUrl === https://…`, `content === "ok"` |
| 5 | 302 to a different host | `redirectTo`, `redirectHost === "b.example.com"` populated |
| 6 | 301 to same host | Followed silently; `finalUrl === ".../new"` |
| 7 | 404 response | `error` includes "404", `status === 404` |
| 8 | Successful fetch | LLM receives URL, page markdown, prompt; returns its answer |
| 9 | Identical request twice | Second call hits cache; underlying fetch only fires once; `cached: true` |
| 10 | 200K HTML body, `maxContentChars: 5000` | `truncated: true`, user msg under ~7000 chars |
| 11 | `application/json` body | User msg contains pretty-printed JSON |
| 12 | Provider throws inside `chat()` | `{ error: "…upstream…" }` |

## Manual smoke (optional)

```ts
import { Agent } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";

const agent = await Agent.create({
  name: "smoke",
  model: new OpenAIProvider({ model: "gpt-4o-mini" }),
});
const r = await agent.run(
  "Use web_fetch on https://example.com and summarise it in one sentence."
);
console.log(r.content);
```

## Regression

Full suite `pnpm test`: 54 files / 448 tests — green before, green after.
