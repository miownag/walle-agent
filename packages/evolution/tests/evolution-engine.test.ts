import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  LLMProvider,
  LLMChatRequest,
  LLMChatResponse,
  LLMStreamChunk,
  ModelMessage,
} from "@walle-agent/core";
import { MemoryManager } from "@walle-agent/memory";
import { SkillRegistry, SkillFileStore } from "@walle-agent/skills";
import { EvolutionEngine } from "../src/evolution-engine.js";
import { ProposalFileStore } from "../src/proposal-file-store.js";
import type { EvolutionPluginConfig } from "../src/evolution-types.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "walle-evol-eng-"));
}

/** MockProvider that returns preset JSON responses for evolution extraction prompts. */
class MockProvider implements LLMProvider {
  name = "mock-evol";
  calls: LLMChatRequest[] = [];
  queue: string[] = [];

  enqueue(text: string): void {
    this.queue.push(text);
  }

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.calls.push(request);
    const content = this.queue.shift() ?? "{}";
    return {
      message: { role: "assistant", content },
    };
  }

  async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    this.calls.push(request);
    const content = this.queue.shift() ?? "{}";
    yield { type: "text_delta", content };
    yield {
      type: "message_complete",
      message: { role: "assistant", content },
    };
  }
}

async function makeDeps(configOverrides: Partial<EvolutionPluginConfig> = {}) {
  const dir = await tmpDir();
  const memPath = path.join(dir, "memories.jsonl");
  const projectScope = path.join(dir, "project");
  const proposalsDir = path.join(dir, "proposals");

  const memory = new MemoryManager({ filePath: memPath, dedupThreshold: 0.9 });
  await memory.init();

  const projectStore = new SkillFileStore(projectScope, "project");
  const skills = new SkillRegistry({ project: projectStore });
  await skills.loadAll();

  const proposalStore = new ProposalFileStore(proposalsDir);

  const provider = new MockProvider();

  const config: EvolutionPluginConfig = {
    explicitRemember: { enabled: true },
    periodicReview: { enabled: true, everyTurns: 3 },
    taskReview: { enabled: true, minToolCalls: 2 },
    memoryCreation: { enabled: true, minImportance: 0.3, minConfidence: 0.3 },
    skillCreation: { enabled: true, requireApproval: true, minConfidence: 0.5 },
    ...configOverrides,
  };

  const engine = new EvolutionEngine({
    config,
    model: provider,
    memory,
    skills,
    proposalStore,
  });

  return { engine, memory, skills, proposalStore, provider, dir };
}

function userMsg(content: string): ModelMessage {
  return { role: "user", content };
}
function asstMsg(content: string): ModelMessage {
  return { role: "assistant", content };
}
function toolMsg(toolCallId: string, content: string): ModelMessage {
  return { role: "tool", toolCallId, content };
}

describe("EvolutionEngine — triggers", () => {
  let harness: Awaited<ReturnType<typeof makeDeps>>;

  beforeEach(async () => {
    harness = await makeDeps();
  });

  it("explicit remember: extracts memory and auto-applies (no approval required)", async () => {
    const { engine, memory, provider } = harness;

    provider.enqueue(
      JSON.stringify({
        memories: [
          {
            type: "preference",
            content: "user prefers pnpm over npm",
            importance: 0.8,
            confidence: 0.9,
            scope: "long",
            tags: ["package-manager"],
          },
        ],
      }),
    );

    const messages: ModelMessage[] = [
      userMsg("remember that I prefer pnpm over npm"),
      asstMsg("Noted."),
    ];

    await engine.afterRun({ turnCounter: 1, runId: "r1", sessionId: "s1", messages });

    const stored = await memory.list();
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toContain("pnpm");
    expect(stored[0].type).toBe("preference");
  });

  it("explicit remember: respects importance/confidence gates", async () => {
    const { engine, memory, provider } = await makeDeps({
      memoryCreation: { enabled: true, minImportance: 0.9, minConfidence: 0.9 },
    });

    provider.enqueue(
      JSON.stringify({
        memories: [
          {
            type: "fact",
            content: "casual fact",
            importance: 0.5,
            confidence: 0.5,
            scope: "long",
          },
        ],
      }),
    );

    await engine.afterRun({
      turnCounter: 1,
      runId: "r1",
      messages: [userMsg("remember that fact"), asstMsg("ok")],
    });

    expect(await memory.list()).toHaveLength(0);
  });

  it("explicit remember: with requireApproval=true enqueues and does NOT auto-apply", async () => {
    const { engine, memory, proposalStore, provider } = await makeDeps({
      memoryCreation: { enabled: true, requireApproval: true, minImportance: 0.3, minConfidence: 0.3 },
    });

    provider.enqueue(
      JSON.stringify({
        memories: [
          { type: "fact", content: "A", importance: 0.9, confidence: 0.9, scope: "long" },
        ],
      }),
    );

    await engine.afterRun({
      turnCounter: 1,
      runId: "r1",
      messages: [userMsg("remember this"), asstMsg("ok")],
    });

    expect(await memory.list()).toHaveLength(0);
    const pending = await proposalStore.list({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe("memory");
  });

  it("periodic review: fires on the Nth run only", async () => {
    const { engine, memory, provider } = await makeDeps({
      explicitRemember: { enabled: false },
      periodicReview: { enabled: true, everyTurns: 3 },
      memoryCreation: { enabled: true, minImportance: 0.3, minConfidence: 0.3 },
    });

    provider.enqueue(
      JSON.stringify({
        memories: [
          { type: "summary", content: "session summary", importance: 0.7, confidence: 0.9, scope: "mid" },
        ],
      }),
    );

    // Turn 1 — no fire
    await engine.afterRun({ turnCounter: 1, runId: "r1", messages: [userMsg("x"), asstMsg("y")] });
    expect(await memory.list()).toHaveLength(0);

    // Turn 3 — fires
    await engine.afterRun({ turnCounter: 3, runId: "r3", messages: [userMsg("x"), asstMsg("y")] });
    expect(await memory.list()).toHaveLength(1);
  });

  it("task review: proposes a Skill when tool_call count >= minToolCalls", async () => {
    const { engine, skills, proposalStore, provider } = await makeDeps({
      explicitRemember: { enabled: false },
      periodicReview: { enabled: false },
      taskReview: { enabled: true, minToolCalls: 2 },
      skillCreation: { enabled: true, requireApproval: false, minConfidence: 0.5 },
    });

    provider.enqueue(
      JSON.stringify({
        skill: {
          name: "deploy_nextjs",
          description: "Deploy a Next.js app to Vercel",
          content: "1. pnpm test\n2. pnpm build\n3. vercel --prod",
          tags: ["deploy", "vercel"],
          confidence: 0.85,
          triggerExamples: ["deploy to vercel"],
          triggerKeywords: ["deploy", "vercel"],
        },
      }),
    );

    const messages: ModelMessage[] = [
      userMsg("deploy to vercel"),
      asstMsg("running tests..."),
      toolMsg("t1", "tests pass"),
      toolMsg("t2", "build ok"),
      toolMsg("t3", "deployed"),
      asstMsg("done"),
    ];

    await engine.afterRun({ turnCounter: 1, runId: "r1", messages });

    // With requireApproval=false, skill should be registered immediately.
    const registered = skills.list();
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe("deploy_nextjs");
    expect(registered[0].metadata.createdBy).toBe("agent");

    // Proposal record is "applied".
    const all = await proposalStore.list();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("applied");
  });

  it("task review: requireApproval=true enqueues a skill proposal but does not register", async () => {
    const { engine, skills, proposalStore, provider } = await makeDeps({
      explicitRemember: { enabled: false },
      periodicReview: { enabled: false },
      taskReview: { enabled: true, minToolCalls: 2 },
      skillCreation: { enabled: true, requireApproval: true, minConfidence: 0.5 },
    });

    provider.enqueue(
      JSON.stringify({
        skill: {
          name: "deploy_nextjs",
          description: "deploy",
          content: "steps...",
          confidence: 0.85,
        },
      }),
    );

    const messages: ModelMessage[] = [
      userMsg("deploy"),
      toolMsg("t1", "ok"),
      toolMsg("t2", "ok"),
      asstMsg("done"),
    ];
    await engine.afterRun({ turnCounter: 1, runId: "r1", messages });

    expect(skills.list()).toHaveLength(0);
    const pending = await proposalStore.list({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe("skill");
  });

  it("approvalHandler: returning true applies without queueing", async () => {
    const seen: string[] = [];
    const { engine, memory, provider } = await makeDeps({
      memoryCreation: { enabled: true, requireApproval: true, minImportance: 0.3, minConfidence: 0.3 },
      approvalHandler: async (p) => {
        seen.push(p.type);
        return true;
      },
    });

    provider.enqueue(
      JSON.stringify({
        memories: [
          { type: "fact", content: "x", importance: 0.9, confidence: 0.9, scope: "long" },
        ],
      }),
    );

    await engine.afterRun({
      turnCounter: 1,
      runId: "r1",
      messages: [userMsg("remember this"), asstMsg("ok")],
    });

    expect(seen).toEqual(["memory"]);
    expect((await memory.list())[0].content).toBe("x");
  });

  it("malformed LLM JSON is tolerated (no memories extracted)", async () => {
    const { engine, memory, provider } = harness;
    provider.enqueue("this is not json at all");

    await engine.afterRun({
      turnCounter: 1,
      runId: "r1",
      messages: [userMsg("remember this"), asstMsg("ok")],
    });

    expect(await memory.list()).toHaveLength(0);
  });

  it("handles fenced ```json blocks", async () => {
    const { engine, memory, provider } = harness;
    provider.enqueue(
      "```json\n" +
        JSON.stringify({
          memories: [
            { type: "fact", content: "boxed", importance: 0.8, confidence: 0.8, scope: "long" },
          ],
        }) +
        "\n```",
    );

    await engine.afterRun({
      turnCounter: 1,
      runId: "r1",
      messages: [userMsg("remember this"), asstMsg("ok")],
    });

    expect((await memory.list())[0].content).toBe("boxed");
  });
});
