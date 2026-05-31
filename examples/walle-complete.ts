/**
 * walle-complete.ts — end-to-end demo wiring every Walle plugin together.
 *
 * Capabilities exercised:
 *   - @walle-agent/openai          → LLM provider (any OpenAI-compatible endpoint)
 *   - @walle-agent/memory          → session log + long-term memory (remember/recall/forget)
 *   - @walle-agent/skills          → SOP catalog injected into the system prompt
 *   - @walle-agent/evolution       → background memory / skill proposals after each run
 *   - @walle-agent/sandbox         → `shell` tool, locally exec'd via execa
 *   - @walle-agent/rag             → file-based knowledge base, auto-injected
 *   - @walle-agent/trace           → JSONL audit log of every event
 *   - @walle-agent/team            → supervisor-style sub-agent delegation
 *   - @walle-agent/mcp (optional)  → external filesystem MCP server
 *   - permissions                  → ask-mode policy with logging approval handler
 *
 * Usage:
 *   pnpm --filter walle-agent-examples run complete
 *   # optional: include MCP filesystem server (first run pulls via npx)
 *   WALLE_DEMO_MCP=1 pnpm --filter walle-agent-examples run complete
 *
 * Required env in `examples/.env`:
 *   API_KEY=sk-xxx
 *   BASE_URL=https://api.openai.com/v1
 *   MODEL=gpt-4o-mini
 */

import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { Agent } from "@walle-agent/core";
import type { ApprovalRequest, PermissionPolicy } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";

import { MemoryPlugin } from "@walle-agent/memory";
import { SkillsPlugin } from "@walle-agent/skills";
import { EvolutionPlugin } from "@walle-agent/evolution";
import { SandboxPlugin } from "@walle-agent/sandbox";
import { SimpleRAGPlugin } from "@walle-agent/rag";
import { TracePlugin } from "@walle-agent/trace";
import { MCPPlugin } from "@walle-agent/mcp";
import { createSupervisorTeam } from "@walle-agent/team";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

const ROOT = resolve(__dirname, "..", ".walle-complete");
const PATHS = {
  root: ROOT,
  kb: resolve(ROOT, "kb"),
  memory: resolve(ROOT, "memory"),
  skillsProject: resolve(ROOT, "agents/project"),
  skillsUser: resolve(ROOT, "agents/user"),
  evolution: resolve(ROOT, "evolution"),
  traces: resolve(ROOT, "traces"),
  sandboxCwd: resolve(ROOT, "workspace"),
  mcpWorkspace: resolve(ROOT, "mcp-workspace"),
};

// ─── 1. Seed deterministic on-disk state ──────────────────────────────────

async function seedFilesystem(): Promise<void> {
  // Wipe and recreate so each run starts deterministic.
  await rm(ROOT, { recursive: true, force: true });
  for (const p of Object.values(PATHS)) await mkdir(p, { recursive: true });

  // RAG knowledge base — what the agent pretends to know about the org.
  await writeFile(
    resolve(PATHS.kb, "deploy.md"),
    [
      "# Deployment runbook",
      "",
      "Prod deploys go through GitHub Actions: `pnpm build` → `docker build` → push to GHCR.",
      "Tag format: `<git-sha>-prod`. Approval is gated by the `prod-release` workflow.",
      "Rollbacks: re-tag the prior `<sha>-prod` image and trigger `prod-rollback`.",
    ].join("\n"),
  );
  await writeFile(
    resolve(PATHS.kb, "support.md"),
    [
      "# Support runbook",
      "",
      "Checkout failures: 90% are stale Stripe webhook signing secrets.",
      "Rotate via `pnpm secrets:rotate stripe-webhook` then redeploy.",
      "Escalate to #payments-oncall after two consecutive rotations fail.",
    ].join("\n"),
  );

  // A sandbox workspace with a few harmless files for the shell tool to inspect.
  await writeFile(resolve(PATHS.sandboxCwd, "README.md"), "Walle complete demo sandbox.\n");
  await writeFile(resolve(PATHS.sandboxCwd, "TODO.txt"), "ship phase-6\nschedule offsite\n");

  // Optional MCP workspace.
  await writeFile(
    resolve(PATHS.mcpWorkspace, "notes.md"),
    "# MCP notes\n- Mounted as the filesystem MCP server's root.\n",
  );
}

// ─── 2. Permissions policy — auto-approve but log every prompt ────────────

function permissionPolicy(): PermissionPolicy {
  return {
    mode: "ask",
    requireApprovalFor: {
      shell: true, // gated via tools tagged "shell" (sandbox + builtin bash)
      fileWrite: true, // gated via tools tagged "file-write"
      riskLevel: ["high"],
    },
    approvalHandler: async (req: ApprovalRequest) => {
      const args = JSON.stringify(req.call.arguments).slice(0, 120);
      console.log(`   🔐 permission [auto-approve] ${req.tool.name}(${args})`);
      return true;
    },
  };
}

// ─── 3. Plugin construction (shared by main + sub-agents) ─────────────────

function buildOpenAI() {
  return new OpenAIProvider({
    model: process.env.MODEL!,
    baseURL: process.env.BASE_URL!,
    apiKey: process.env.API_KEY,
  });
}

async function buildMcpPlugin(): Promise<MCPPlugin | null> {
  if (process.env.WALLE_DEMO_MCP !== "1") return null;
  return new MCPPlugin([
    {
      name: "filesystem",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", PATHS.mcpWorkspace],
      },
    },
  ]);
}

// ─── 4. Main flow ─────────────────────────────────────────────────────────

async function main() {
  await seedFilesystem();

  const sessionId = `complete-${Date.now()}`;

  // Plugins shared across both runs of the main agent (so Memory / Skills /
  // Evolution / Trace / RAG / Sandbox state persists across resume).
  const trace = new TracePlugin({
    store: "jsonl",
    storePath: PATHS.traces,
    recordContent: true, // demo only — flip off in production
  });
  const memory = new MemoryPlugin({ rootDir: PATHS.memory });
  const skills = new SkillsPlugin({
    project: PATHS.skillsProject,
    user: PATHS.skillsUser,
  });
  const evolution = new EvolutionPlugin({
    rootDir: PATHS.evolution,
    explicitRemember: { enabled: true },
    periodicReview: { enabled: false }, // off for short demo
    taskReview: { enabled: true, minToolCalls: 2 },
    memoryCreation: { enabled: true, requireApproval: false, minImportance: 0.4 },
    skillCreation: { enabled: true, requireApproval: true, minConfidence: 0.6 },
    onProposal: async (p) => {
      console.log(`   ⚙️  evolution proposal [${p.type}] reason=${p.reason}`);
    },
  });
  const sandbox = new SandboxPlugin({
    type: "local",
    local: {
      cwd: PATHS.sandboxCwd,
      defaultTimeoutMs: 5_000,
      // Conservative whitelist for the demo. Loosen as needed.
      allowedCommands: ["sh", "ls", "cat", "echo", "pwd", "wc", "head"],
    },
  });
  const rag = new SimpleRAGPlugin({
    docsPath: PATHS.kb,
    patterns: ["**/*.md"],
    chunkSize: 600,
    chunkOverlap: 80,
  });
  const mcp = await buildMcpPlugin();

  const mainPlugins = [
    trace,
    memory,
    skills,
    evolution,
    sandbox,
    rag,
    ...(mcp ? [mcp] : []),
  ];

  const systemPrompt = [
    "You are Walle, a senior infrastructure copilot.",
    "",
    "Operating rules:",
    "- Use the `[Knowledge]` items injected into your prompt as the source of truth for runbooks.",
    "- Use `remember` to save durable user preferences when the user teaches you something.",
    "- Use `recall` before asking a question that may already be in memory.",
    "- For any system-level inspection, prefer the `shell` tool (sandboxed) over `bash`.",
    "- Be concise. One short paragraph or a bullet list, no fluff.",
  ].join("\n");

  const agent = await Agent.create({
    name: "Walle",
    model: buildOpenAI(),
    systemPrompt,
    sessionId,
    permissions: permissionPolicy(),
    plugins: mainPlugins,
    // Coexistence: SandboxPlugin's `shell` is preferred — drop the built-in `bash`.
    useBuiltinTools: { excludeTools: ["bash"] },
  });

  // ─── Scenario A — RAG-grounded answer ───────────────────────────────
  console.log("\n📚 [A] Knowledge-base question (RAG)");
  console.log(`── user → How do we deploy to production?`);
  const a = await agent.run("How do we deploy to production?", { sessionId });
  console.log(`── assistant → ${a.content}`);

  // ─── Scenario B — Teach a preference (memory + evolution) ───────────
  console.log("\n🧠 [B] Teach a durable preference");
  const teach = "Please remember: I always use pnpm, never npm or yarn.";
  console.log(`── user → ${teach}`);
  const b = await agent.run(teach, { sessionId });
  console.log(`── assistant → ${b.content}`);

  // Give the background evolution engine a tick to extract memories.
  await new Promise((r) => setTimeout(r, 1500));

  // ─── Scenario C — Recall via memory (cross-turn) ────────────────────
  console.log("\n🔁 [C] Recall the preference on a follow-up turn");
  console.log(`── user → Which package manager should I use for a new project?`);
  const c = await agent.run(
    "Which package manager should I use for a new project?",
    { sessionId },
  );
  console.log(`── assistant → ${c.content}`);

  // ─── Scenario D — Sandbox shell (permission gate fires) ─────────────
  console.log("\n🛡  [D] Sandboxed shell command (permission gate)");
  console.log(`── user → List the files in your sandbox workspace.`);
  const d = await agent.run(
    `List the files in your sandbox workspace and tell me what they say. ` +
      `Use the shell tool with \`ls -la\` and \`cat\` against the cwd.`,
    { sessionId },
  );
  console.log(`── assistant → ${d.content}`);
  if (d.toolCalls.length > 0) {
    console.log("   tool calls this turn:");
    for (const tc of d.toolCalls) {
      console.log(
        `     • ${tc.name} → status=${tc.status} dur=${tc.durationMs ?? 0}ms`,
      );
    }
  }

  // ─── Scenario E — Multi-agent supervisor team ───────────────────────
  console.log("\n🤝 [E] Supervisor team delegating to specialists");

  const researcher = await Agent.create({
    name: "Researcher",
    model: buildOpenAI(),
    systemPrompt:
      "You are a research specialist. Use the [Knowledge] context to answer briefly.",
    plugins: [
      new SimpleRAGPlugin({
        docsPath: PATHS.kb,
        patterns: ["**/*.md"],
        chunkSize: 600,
      }),
    ],
  });
  const triage = await Agent.create({
    name: "Triage",
    model: buildOpenAI(),
    systemPrompt:
      "You are a triage specialist. Given a problem statement, list the top-3 things to check first. Be concrete.",
  });

  const team = await createSupervisorTeam({
    members: [
      {
        name: "Researcher",
        agent: researcher,
        role: "look up runbook material from the knowledge base",
      },
      {
        name: "Triage",
        agent: triage,
        role: "produce a focused, ranked checklist",
      },
    ],
    coordinator: { model: buildOpenAI(), name: "WalleSupervisor" },
  });

  const teamTask =
    "A customer just reported their checkout is failing. Coordinate the team: " +
    "have the researcher look up our runbook, then have triage turn it into a 3-step checklist.";
  console.log(`── user → ${teamTask}`);
  const e = await team.run(teamTask, { strategy: "supervisor" });
  console.log(`── team → ${e.content}`);

  // ─── Summary ────────────────────────────────────────────────────────
  console.log("\n📊 Final state");

  const memList = await memory.manager.list();
  console.log(`   memories (long-term): ${memList.length}`);
  for (const m of memList.slice(0, 5)) {
    console.log(`     • [${m.type}] ${m.content}`);
  }

  const proposals = await evolution.pending();
  console.log(`   evolution proposals pending: ${proposals.length}`);
  for (const p of proposals.slice(0, 5)) {
    const payload = p.payload as { name?: string; content?: string; confidence?: number };
    console.log(`     • [${p.type}] ${payload.name ?? payload.content ?? "?"}`);
  }

  const traceId = trace.getCurrentTraceId();
  const events = traceId ? await trace.getStore().getTrace(traceId) : [];
  const counts = events.reduce<Record<string, number>>((acc, ev) => {
    acc[ev.type] = (acc[ev.type] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `   trace events for the last run (${traceId ?? "n/a"}): ${events.length}`,
  );
  for (const [type, n] of Object.entries(counts).sort()) {
    console.log(`     • ${type}: ${n}`);
  }
  console.log(`   trace store: ${PATHS.traces}`);
  console.log(`   sandbox cwd: ${PATHS.sandboxCwd}`);

  // ─── Cleanup ────────────────────────────────────────────────────────
  await researcher.dispose();
  await triage.dispose();
  await agent.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
