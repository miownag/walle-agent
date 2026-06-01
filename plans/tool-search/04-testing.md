# Tool Search — Testing

> Vitest + 现有 mock LLMProvider；不引外部库。

## A1 — `ToolRegistry` shadow

**File**: `packages/core/tests/tool-registry.test.ts`（扩展或新建）

```ts
it("registers shadowed when opts.shadow=true", () => {
  const r = new ToolRegistry();
  r.register(t("a"));
  r.register(t("b"), { shadow: true });
  expect(r.listActive().map((x) => x.name)).toEqual(["a"]);
  expect(r.listShadowed().map((x) => x.name)).toEqual(["b"]);
  expect(r.list().length).toBe(2);
});

it("toModelTools excludes shadowed", () => {
  const r = new ToolRegistry();
  r.register(t("a"));
  r.register(t("b", ["mcp"]));
  r.shadow("b");
  expect(r.toModelTools().map((x) => x.function.name)).toEqual(["a"]);
});

it("get() returns even shadowed tools", () => {
  const r = new ToolRegistry();
  r.register(t("a"), { shadow: true });
  expect(r.get("a")).toBeDefined();
});

it("shadow/unshadow round-trip", () => { /* … */ });
```

## A2 — Tag 完整性

- 静态校验：导入 `BUILTIN_TOOLS`，断言每个工具的 `tags?.includes("builtin")`。
- MCP adapter 单测里断言 `tags === ["mcp", serverName]`（已有可扩展）。

## B1 — Resolve toolSearch defaults

**File**: `packages/core/tests/agent-config.test.ts`

- 不传 → resolved 为 `{ enabled: true, mode: "auto", threshold: 30, alwaysShadowTags: ["mcp"], alwaysActiveTags: ["builtin"] }`。
- `{ enabled: false }` → mode 强制 "off"。
- `{ mode: "force" }` → threshold 仍接受任意值，shadow 决策不看 threshold。

## B2 — Events

- `tool_search_done` / `tool_defer_executed` 监听器收到正确 payload。

## B3 — Agent inspection

- `agent.listVisibleTools().length + agent.listHiddenTools().length === all`.

## C1 — `compileKeyword` / `score`

**File**: `packages/core/tests/builtin-tools/tool-search.score.test.ts`

```ts
it("regex matcher", () => {
  const m = compileKeyword("/^fs_/i");
  expect(m.test("FS_read").matched).toBe(true);
  expect(m.test("nope").matched).toBe(false);
});

it("plain matcher case-insensitive substring", () => {
  const m = compileKeyword("Read");
  expect(m.test("readFile").matched).toBe(true);
  expect(m.test("readFile").whole).toBe(false);
  expect(m.test("READ_LINE").matched).toBe(true);
});

it("score: regex > whole-word > substring; name > description", () => {
  const tool = { name: "fs_read", description: "Read a file", tags: [], parameters: {} } as Tool;
  expect(score(tool, [compileKeyword("/^fs_/")])).toBe(1.0);
  expect(score(tool, [compileKeyword("read")])).toBe(0.8);   // whole-word in name
  expect(score(tool, [compileKeyword("file")])).toBe(0.5);   // whole-word in desc
  expect(score(tool, [compileKeyword("xyz")])).toBe(0);
});
```

## C2 — `createToolSearchTool` integration

**File**: `packages/core/tests/builtin-tools/tool-search.test.ts`

```ts
it("returns sorted matches with metadata", async () => {
  const r = new ToolRegistry();
  r.register(mkTool("fs_read", "Read a file", ["mcp", "fs"]));
  r.register(mkTool("fs_write", "Write a file", ["mcp", "fs"]));
  r.register(mkTool("bash", "Run shell command", ["builtin"]));
  const tool = createToolSearchTool({ registry: r });

  const out = await tool.execute({ keywords: ["read"] }, mkCtx());
  expect(out.matches[0].qualifiedName).toBe("fs_read");
  expect(out.matches[0].server).toBe("fs");
  expect(out.matches[0].score).toBeGreaterThan(0);
  expect(out.totalCandidates).toBe(1);
});

it("filters by servers", async () => {
  /* server filter excludes bash */
});

it("filters by tags", async () => { /* … */ });

it("limit + truncated flag", async () => { /* … */ });

it("excludes self + defer_execute_tool", async () => { /* … */ });

it("emits tool_search_done", async () => { /* spy on agent.getEventBus */ });
```

## D1 — `createDeferExecuteTool`

**File**: `packages/core/tests/builtin-tools/defer-execute-tool.test.ts`

```ts
it("executes the matching shadow tool", async () => {
  const target = mkTool("hidden_one", "...", ["mcp"], async (input) => "ran:" + JSON.stringify(input));
  const r = new ToolRegistry();
  r.register(target, { shadow: true });
  const tool = createDeferExecuteTool({
    registry: r,
    checkPermission: async () => ({ allowed: true }),
  });
  const out = await tool.execute(
    { qualifiedName: "hidden_one", arguments: { x: 1 } },
    mkCtx(),
  );
  expect(out).toBe('ran:{"x":1}');
});

it("returns error on unknown qualifiedName", async () => { /* … */ });

it("respects permission denial", async () => {
  const tool = createDeferExecuteTool({
    registry: r,
    checkPermission: async () => ({ allowed: false, reason: "deny" }),
  });
  const out = await tool.execute({ qualifiedName: "x", arguments: {} }, mkCtx());
  expect(out).toEqual({ error: "permission denied", reason: "deny" });
});

it("rejects executing tool_search/defer_execute_tool itself", async () => { /* … */ });

it("converts thrown errors to {error}", async () => { /* … */ });

it("emits tool_defer_executed with status + duration", async () => { /* … */ });
```

## E1 — `applyToolSearchPolicy`

**File**: `packages/core/tests/agent-runtime.tool-search.test.ts`

```ts
it("does not shadow when total tools <= threshold (auto)", async () => {
  const agent = await Agent.create({
    name: "A", model: mockModel(),
    tools: many(5),
    toolSearch: { enabled: true, mode: "auto", threshold: 30 },
  });
  expect(agent.listHiddenTools().length).toBe(0);
});

it("shadows MCP tools when total > threshold (auto)", async () => {
  const mcpish = many(50, { tags: ["mcp", "fake"] });
  const agent = await Agent.create({
    name: "A", model: mockModel(),
    tools: mcpish,
    toolSearch: { enabled: true, mode: "auto", threshold: 30 },
    useBuiltinTools: false,    // exclude builtins for clarity
  });
  expect(agent.listHiddenTools().length).toBe(50);
  expect(agent.listVisibleTools().map((t) => t.name).sort()).toEqual(
    ["defer_execute_tool", "tool_search"],
  );
});

it("force mode ignores threshold", async () => {
  const agent = await Agent.create({
    name: "A", model: mockModel(),
    tools: many(3, { tags: ["mcp", "fake"] }),
    toolSearch: { enabled: true, mode: "force" },
    useBuiltinTools: false,
  });
  expect(agent.listHiddenTools().length).toBe(3);
});

it("off mode keeps everything visible", async () => {
  const agent = await Agent.create({
    /* ... */
    toolSearch: { enabled: false },
  });
  expect(agent.listHiddenTools().length).toBe(0);
});

it("alwaysActiveTags wins over alwaysShadowTags", async () => {
  const t = mkTool("hybrid", "", ["mcp", "builtin"]);   // weird but legal
  const agent = await Agent.create({ /* tools: [t], force */ });
  expect(agent.listHiddenTools().length).toBe(0);
});

it("does not register search/defer when shadowable is empty", async () => {
  const agent = await Agent.create({
    /* tools all native, no mcp tag */
    toolSearch: { enabled: true, mode: "force" },
  });
  expect(agent.listVisibleTools().find((t) => t.name === "tool_search")).toBeUndefined();
});
```

## E2 — useBuiltinTools 兼容

```ts
it("warns when both helpers excluded but tools shadowed", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await Agent.create({
    /* lots of mcp tools */
    useBuiltinTools: { excludeTools: ["tool_search", "defer_execute_tool"] },
    toolSearch: { enabled: true, mode: "force" },
  });
  expect(warn).toHaveBeenCalled();
});

it("respects useBuiltinTools: false → does not shadow nor register", async () => { /* … */ });
```

## End-to-end (mock) — round trip

**File**: `packages/core/tests/agent-runtime.tool-search.e2e.test.ts`

- mock provider 接收两轮：
  1. 第一轮调 `tool_search({ keywords: ["read"] })` → 返回 matches。
  2. 第二轮调 `defer_execute_tool({ qualifiedName: "fs_read", arguments: {...} })` → 返回 hidden 工具结果。
- 断言：两次 tool execute 都成功，且 messages 序列正确。

## F — Docs

- 不覆盖代码；通过 `pnpm lint` + manual review。

## G — Verification

- `pnpm test` 全绿。
- `pnpm -F @walle-agent/core test --coverage`：`tool-search.ts` / `defer-execute-tool.ts` ≥ 90%；`tool-registry.ts` 新增 ≥ 90%；`agent-runtime.applyToolSearchPolicy` 分支覆盖完整。
- `pnpm build` 通过。

## Mock helpers (shared)

- `mkTool(name, desc, tags, exec?)`：构造 `Tool` 实例。
- `many(n, base?)`：批量生成 tools。
- `mkCtx()`：构造 `ToolExecutionContext`，注入 stub agent + EventBus。
