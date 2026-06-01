/**
 * Tests for built-in tools: filesystem, shell, plan, todos
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  lsTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  planTool,
  writeTodosTool,
  clearPlanStore,
  clearTodoStore,
  BUILTIN_TOOLS,
} from "../src/builtin-tools/index.js";

// ─── Filesystem Tools ─────────────────────────────────────────────

describe("Filesystem Tools", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `walle-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe("ls", () => {
    it("should list files in a directory", async () => {
      await fs.writeFile(join(testDir, "a.txt"), "hello");
      await fs.writeFile(join(testDir, "b.ts"), "world");
      await fs.mkdir(join(testDir, "sub"));

      const result = await lsTool.execute({ path: testDir });
      expect(result.entries).toHaveLength(3);
    });

    it("should show detailed info", async () => {
      await fs.writeFile(join(testDir, "file.txt"), "content");

      const result = await lsTool.execute({ path: testDir, detailed: true });
      expect(result.entries[0]).toHaveProperty("size");
      expect(result.entries[0]).toHaveProperty("modified");
    });

    it("should support recursive listing", async () => {
      await fs.mkdir(join(testDir, "sub"), { recursive: true });
      await fs.writeFile(join(testDir, "root.txt"), "");
      await fs.writeFile(join(testDir, "sub", "nested.txt"), "");

      const result = await lsTool.execute({ path: testDir, recursive: true });
      expect(result.recursiveEntries.length).toBeGreaterThanOrEqual(3);
    });

    it("should return error for non-existent path", async () => {
      const result = await lsTool.execute({ path: "/non/existent/path" });
      expect(result.error).toBeDefined();
    });
  });

  describe("read_file", () => {
    it("should read entire file", async () => {
      const testFile = join(testDir, "test.txt");
      await fs.writeFile(testFile, "line1\nline2\nline3");

      const result = await readFileTool.execute({ path: testFile });
      expect(result.content).toBe("line1\nline2\nline3");
      expect(result.totalLines).toBe(3);
    });

    it("should read specific line range", async () => {
      const testFile = join(testDir, "test.txt");
      await fs.writeFile(testFile, "L1\nL2\nL3\nL4\nL5");

      const result = await readFileTool.execute({ path: testFile, startLine: 2, endLine: 4 });
      expect(result.content).toBe("L2\nL3\nL4");
      expect(result.readLines).toEqual({ start: 2, end: 4 });
    });

    it("should return error for missing file", async () => {
      const result = await readFileTool.execute({ path: join(testDir, "nope.txt") });
      expect(result.error).toBeDefined();
    });
  });

  describe("write_file", () => {
    it("should create a new file", async () => {
      const testFile = join(testDir, "new.txt");
      const result = await writeFileTool.execute({ path: testFile, content: "hello" });

      expect(result.status).toBe("success");
      expect(await fs.readFile(testFile, "utf-8")).toBe("hello");
    });

    it("should overwrite existing file", async () => {
      const testFile = join(testDir, "exist.txt");
      await fs.writeFile(testFile, "old");

      await writeFileTool.execute({ path: testFile, content: "new" });
      expect(await fs.readFile(testFile, "utf-8")).toBe("new");
    });

    it("should create parent directories", async () => {
      const testFile = join(testDir, "a", "b", "c.txt");
      const result = await writeFileTool.execute({ path: testFile, content: "deep" });

      expect(result.status).toBe("success");
      expect(await fs.readFile(testFile, "utf-8")).toBe("deep");
    });
  });

  describe("edit_file", () => {
    it("should replace text globally", async () => {
      const testFile = join(testDir, "edit.txt");
      await fs.writeFile(testFile, "foo bar foo baz");

      const result = await editFileTool.execute({ path: testFile, search: "foo", replace: "qux" });
      expect(result.status).toBe("success");
      expect(await fs.readFile(testFile, "utf-8")).toBe("qux bar qux baz");
    });

    it("should replace only first occurrence when global=false", async () => {
      const testFile = join(testDir, "edit.txt");
      await fs.writeFile(testFile, "aaa bbb aaa");

      await editFileTool.execute({ path: testFile, search: "aaa", replace: "ccc", global: false });
      expect(await fs.readFile(testFile, "utf-8")).toBe("ccc bbb aaa");
    });

    it("should return error when text not found", async () => {
      const testFile = join(testDir, "edit.txt");
      await fs.writeFile(testFile, "hello");

      const result = await editFileTool.execute({ path: testFile, search: "world", replace: "x" });
      expect(result.error).toContain("not found");
    });
  });

  describe("glob", () => {
    it("should find files by pattern", async () => {
      await fs.writeFile(join(testDir, "a.ts"), "");
      await fs.writeFile(join(testDir, "b.ts"), "");
      await fs.writeFile(join(testDir, "c.js"), "");

      const result = await globTool.execute({ pattern: "*.ts", cwd: testDir });
      expect(result.count).toBe(2);
      expect(result.matches).toContain("a.ts");
      expect(result.matches).toContain("b.ts");
    });
  });

  describe("grep", () => {
    it("should search text in files", async () => {
      const testFile = join(testDir, "search.txt");
      await fs.writeFile(testFile, "hello world\nfoo bar\nhello again");

      const result = await grepTool.execute({ pattern: "hello", file: testFile });
      expect(result.filesMatched).toBe(1);
      expect(result.results[0].lines).toHaveLength(2);
    });

    it("should support case-insensitive search", async () => {
      const testFile = join(testDir, "case.txt");
      await fs.writeFile(testFile, "Hello\nhello\nHELLO");

      const result = await grepTool.execute({ pattern: "hello", file: testFile, ignoreCase: true });
      expect(result.results[0].lines).toHaveLength(3);
    });

    it("should support regex", async () => {
      const testFile = join(testDir, "regex.txt");
      await fs.writeFile(testFile, "test123\ntest456\nhello");

      const result = await grepTool.execute({ pattern: "test\\d+", file: testFile, regex: true });
      expect(result.results[0].lines).toHaveLength(2);
    });
  });
});

// ─── Shell Tool ───────────────────────────────────────────────────

describe("bash tool", () => {
  it("should execute a command", async () => {
    const result = await bashTool.execute({ command: "echo hello" });
    expect(result.status).toBe("success");
    expect(result.output).toContain("hello");
    expect(result.exitCode).toBe(0);
  });

  it("should handle command errors", async () => {
    const result = await bashTool.execute({ command: "exit 1" });
    expect(result.status).toBe("error");
    expect(result.exitCode).toBe(1);
  });

  it("should respect timeout", async () => {
    const result = await bashTool.execute({ command: "sleep 10", timeout: 100 });
    expect(result.status).toBe("error");
  });

  it("should use custom cwd", async () => {
    const result = await bashTool.execute({ command: "pwd", cwd: "/tmp" });
    expect(result.output).toContain("/tmp");
  });
});

// ─── Plan Tool ────────────────────────────────────────────────────

describe("plan tool", () => {
  beforeEach(() => {
    clearPlanStore();
  });

  it("should create a plan", async () => {
    const result = await planTool.execute({
      action: "create",
      title: "Test Plan",
      steps: [
        { content: "Step 1" },
        { content: "Step 2" },
        { content: "Step 3" },
      ],
    });

    expect(result.status).toBe("success");
    expect(result.plan.title).toBe("Test Plan");
    expect(result.plan.steps).toHaveLength(3);
    expect(result.plan.steps[0].status).toBe("pending");
    expect(result.plan.status).toBe("active");
  });

  it("should require title and steps for create", async () => {
    const r1 = await planTool.execute({ action: "create" });
    expect(r1.error).toContain("title");

    const r2 = await planTool.execute({ action: "create", title: "X" });
    expect(r2.error).toContain("steps");
  });

  it("should get a plan with progress", async () => {
    const created = await planTool.execute({
      action: "create",
      title: "My Plan",
      steps: [{ content: "A" }, { content: "B", status: "completed" }],
    });

    const result = await planTool.execute({ action: "get", planId: created.plan.id });
    expect(result.plan.title).toBe("My Plan");
    expect(result.progress.total).toBe(2);
    expect(result.progress.completed).toBe(1);
    expect(result.progress.pending).toBe(1);
  });

  it("should list all plans", async () => {
    await planTool.execute({ action: "create", title: "P1", steps: [{ content: "s" }] });
    await planTool.execute({ action: "create", title: "P2", steps: [{ content: "s" }] });

    const result = await planTool.execute({ action: "list" });
    expect(result.totalPlans).toBe(2);
  });

  it("should update a plan", async () => {
    const created = await planTool.execute({
      action: "create",
      title: "Original",
      steps: [{ content: "old step" }],
    });

    const result = await planTool.execute({
      action: "update",
      planId: created.plan.id,
      title: "Updated",
      steps: [{ content: "new step 1" }, { content: "new step 2" }],
    });

    expect(result.plan.title).toBe("Updated");
    expect(result.plan.steps).toHaveLength(2);
  });

  it("should update a single step", async () => {
    const created = await planTool.execute({
      action: "create",
      title: "Plan",
      steps: [{ content: "A" }, { content: "B" }],
    });

    const result = await planTool.execute({
      action: "update_step",
      planId: created.plan.id,
      stepId: "step_1",
      stepStatus: "completed",
    });

    expect(result.updatedStep.status).toBe("completed");
    expect(result.plan.status).toBe("active"); // not all completed
  });

  it("should auto-complete plan when all steps done", async () => {
    const created = await planTool.execute({
      action: "create",
      title: "Plan",
      steps: [{ content: "A" }, { content: "B" }],
    });

    await planTool.execute({
      action: "update_step",
      planId: created.plan.id,
      stepId: "step_1",
      stepStatus: "completed",
    });

    const result = await planTool.execute({
      action: "update_step",
      planId: created.plan.id,
      stepId: "step_2",
      stepStatus: "completed",
    });

    expect(result.plan.status).toBe("completed");
  });

  it("should delete a plan", async () => {
    const created = await planTool.execute({
      action: "create",
      title: "To Delete",
      steps: [{ content: "x" }],
    });

    const result = await planTool.execute({ action: "delete", planId: created.plan.id });
    expect(result.status).toBe("success");

    const get = await planTool.execute({ action: "get", planId: created.plan.id });
    expect(get.error).toContain("not found");
  });
});

// ─── Todo Tool ────────────────────────────────────────────────────

describe("write_todos tool", () => {
  beforeEach(() => {
    clearTodoStore();
  });

  it("should add a task", async () => {
    const result = await writeTodosTool.execute({ action: "add", task: "Do something" });
    expect(result.status).toBe("success");
    expect(result.addedTask.task).toBe("Do something");
  });

  it("should list tasks", async () => {
    await writeTodosTool.execute({ action: "add", task: "Task 1" });
    await writeTodosTool.execute({ action: "add", task: "Task 2" });

    const result = await writeTodosTool.execute({ action: "list" });
    expect(result.totalTasks).toBe(2);
    expect(result.pending).toBe(2);
  });

  it("should complete a task", async () => {
    const added = await writeTodosTool.execute({ action: "add", task: "Complete me" });
    const result = await writeTodosTool.execute({ action: "complete", taskId: added.addedTask.id });

    expect(result.status).toBe("success");
    expect(result.completedTask.completed).toBe(true);
  });

  it("should remove a task", async () => {
    const added = await writeTodosTool.execute({ action: "add", task: "Remove me" });
    const result = await writeTodosTool.execute({ action: "remove", taskId: added.addedTask.id });

    expect(result.status).toBe("success");
    expect(result.remainingTasks).toBe(0);
  });

  it("should support multiple named lists", async () => {
    await writeTodosTool.execute({ action: "add", task: "A", listName: "work" });
    await writeTodosTool.execute({ action: "add", task: "B", listName: "personal" });

    const work = await writeTodosTool.execute({ action: "list", listName: "work" });
    const personal = await writeTodosTool.execute({ action: "list", listName: "personal" });

    expect(work.totalTasks).toBe(1);
    expect(personal.totalTasks).toBe(1);
  });
});

// ─── BUILTIN_TOOLS Array ──────────────────────────────────────────

describe("BUILTIN_TOOLS", () => {
  it("should contain 10 tools", () => {
    expect(BUILTIN_TOOLS).toHaveLength(10);
  });

  it("should have all expected tool names", () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "ls", "read_file", "write_file", "edit_file", "glob", "grep",
      "bash", "plan", "write_todos", "read_tool_result",
    ]);
  });

  it("should have valid tool interface for each", () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });
});
