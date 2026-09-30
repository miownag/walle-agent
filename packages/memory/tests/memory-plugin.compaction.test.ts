import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Agent } from "@walle-agent/core";
import type {
  LLMChatRequest,
  LLMProvider,
  LLMStreamChunk,
  ModelMessage,
} from "@walle-agent/core";
import { MemoryPlugin } from "../src/memory-plugin.js";

class QueueProvider implements LLMProvider {
  readonly name = "queue";
  readonly calls: LLMChatRequest[] = [];

  constructor(private readonly responses: string[]) {}

  async chat(): Promise<never> {
    throw new Error("not used");
  }

  async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    this.calls.push({
      ...request,
      messages: request.messages.map((message) => ({ ...message })),
    });
    const content = this.responses.shift() ?? "default";
    yield { type: "text_delta", content };
    yield {
      type: "message_complete",
      message: { role: "assistant", content },
      toolCalls: [],
    };
  }
}

function failingProvider(): LLMProvider {
  return {
    name: "failing-summary",
    async chat(): Promise<never> {
      throw new Error("not used");
    },
    async *stream(): AsyncIterable<LLMStreamChunk> {
      yield { type: "error", error: new Error("summary failed") };
    },
  };
}

function contents(messages: ModelMessage[]): Array<string | undefined> {
  return messages.map((message) =>
    typeof message.content === "string" ? message.content : undefined,
  );
}

describe("MemoryPlugin macro-compaction persistence", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "walle-memory-compaction-"));
  });

  it("manual compact atomically replaces history used by the next run", async () => {
    const model = new QueueProvider([
      "answer 1",
      "answer 2",
      "answer 3",
      "answer 4",
    ]);
    const summaryModel = new QueueProvider(["durable summary"]);
    const memory = new MemoryPlugin({
      rootDir: root,
      toolResults: { enabled: false },
      longTerm: { enabled: false },
    });
    const agent = await Agent.create({
      name: "test",
      sessionId: "s1",
      model,
      plugins: [memory],
      useBuiltinTools: false,
    });

    await agent.run("question 1");
    await agent.run("question 2");
    await agent.run("question 3");
    const result = await agent.compact({
      keepRecentTurns: 1,
      summaryModel,
    });

    expect(result.droppedMessages).toBeGreaterThan(0);
    const compacted = await memory.sessionLog!.readMessages("s1");
    expect(contents(compacted.map((record) => record.message))).toEqual([
      "[Summary of 5 earlier messages]\ndurable summary",
      "answer 3",
    ]);

    await agent.run("question 4");
    const nextMessages = contents(model.calls[3].messages);
    expect(nextMessages).toContain(
      "[Summary of 5 earlier messages]\ndurable summary",
    );
    expect(nextMessages).toContain("answer 3");
    expect(nextMessages).toContain("question 4");
    expect(nextMessages).not.toContain("question 1");
    expect(nextMessages).not.toContain("answer 1");
    expect(nextMessages).not.toContain("question 2");
    expect(nextMessages).not.toContain("answer 2");

    await agent.dispose();
  });

  it("live auto compact persists summary plus tail and continues appending", async () => {
    const model = new QueueProvider(["answer 1", "answer 2", "answer 3"]);
    const summaryModel = new QueueProvider(["automatic summary"]);
    const memory = new MemoryPlugin({
      rootDir: root,
      toolResults: { enabled: false },
      longTerm: { enabled: false },
    });
    const agent = await Agent.create({
      name: "test",
      sessionId: "s1",
      systemPrompt: "single system prompt",
      model,
      plugins: [memory],
      useBuiltinTools: false,
      macroCompression: {
        enabled: true,
        threshold: 0,
        keepRecentTurns: 1,
        summaryModel,
      },
    });

    await agent.run("question 1");
    await agent.run("question 2");
    await agent.run("question 3");
    expect(summaryModel.calls).toHaveLength(1);
    await agent.dispose();

    const resumedModel = new QueueProvider(["answer 4"]);
    const resumedMemory = new MemoryPlugin({
      rootDir: root,
      toolResults: { enabled: false },
      longTerm: { enabled: false },
    });
    const resumed = await Agent.create({
      name: "test",
      sessionId: "s1",
      systemPrompt: "single system prompt",
      model: resumedModel,
      plugins: [resumedMemory],
      useBuiltinTools: false,
    });
    await resumed.run("question 4");

    const next = resumedModel.calls[0].messages;
    expect(next.filter((message) => message.role === "system")).toHaveLength(1);
    expect(contents(next)).toEqual([
      "single system prompt",
      "[Summary of 3 earlier messages]\nautomatic summary",
      "answer 2",
      "question 3",
      "answer 3",
      "question 4",
    ]);
    await resumed.dispose();
  });

  it("keeps live-compacted image bytes transient across a restart", async () => {
    const seedModel = new QueueProvider(["answer 1", "answer 2"]);
    const seedMemory = new MemoryPlugin({
      rootDir: root,
      toolResults: { enabled: false },
      longTerm: { enabled: false },
    });
    const seedAgent = await Agent.create({
      name: "test",
      sessionId: "s1",
      model: seedModel,
      plugins: [seedMemory],
      useBuiltinTools: false,
    });
    await seedAgent.run("question 1");
    await seedAgent.run("question 2");
    await seedAgent.dispose();

    const sentinel = "WALLE_TRANSIENT_IMAGE_BYTES_7f63c547";
    const encodedSentinel = Buffer.from(sentinel).toString("base64");
    const attachmentPath = "/repo/.walle/attachments/2026-08-10-capture.png";
    const imageModel = new QueueProvider(["image answer"]);
    const summaryModel = new QueueProvider(["image-safe summary"]);
    const imageMemory = new MemoryPlugin({
      rootDir: root,
      toolResults: { enabled: false },
      longTerm: { enabled: false },
    });
    const imageAgent = await Agent.create({
      name: "test",
      sessionId: "s1",
      model: imageModel,
      plugins: [imageMemory],
      useBuiltinTools: false,
      macroCompression: {
        enabled: true,
        threshold: 0,
        keepRecentTurns: 1,
        summaryModel,
      },
    });

    await imageAgent.run({
      content: `Inspect the attached image at ${attachmentPath}`,
      attachments: [
        {
          type: "image",
          name: "capture.png",
          mimeType: "image/png",
          data: Buffer.from(sentinel),
        },
      ],
    });
    expect(summaryModel.calls).toHaveLength(1);
    await imageAgent.dispose();

    const file = join(root, "sessions", "s1", "messages.jsonl");
    const persisted = await readFile(file, "utf8");
    expect(persisted).toContain(attachmentPath);
    expect(persisted).toContain('[Attachment: type=\\"image\\"');
    expect(persisted).not.toContain(sentinel);
    expect(persisted).not.toContain(encodedSentinel);

    const resumedModel = new QueueProvider(["follow-up answer"]);
    const resumedMemory = new MemoryPlugin({
      rootDir: root,
      toolResults: { enabled: false },
      longTerm: { enabled: false },
    });
    const resumed = await Agent.create({
      name: "test",
      sessionId: "s1",
      model: resumedModel,
      plugins: [resumedMemory],
      useBuiltinTools: false,
    });
    await resumed.run("follow up");

    const restartedRequest = resumedModel.calls[0];
    const restartedJson = JSON.stringify(restartedRequest.messages);
    expect(restartedJson).toContain(attachmentPath);
    expect(restartedJson).toContain('[Attachment: type=\\"image\\"');
    expect(restartedJson).not.toContain(sentinel);
    expect(restartedJson).not.toContain(encodedSentinel);
    expect(
      restartedRequest.messages.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some(
            (block) => block.type === "image" && block.source.type === "base64",
          ),
      ),
    ).toBe(false);
    await resumed.dispose();
  });

  it("does not alter messages.jsonl when summarization fails", async () => {
    const model = new QueueProvider(["answer 1", "answer 2"]);
    const memory = new MemoryPlugin({
      rootDir: root,
      toolResults: { enabled: false },
      longTerm: { enabled: false },
    });
    const agent = await Agent.create({
      name: "test",
      sessionId: "s1",
      model,
      plugins: [memory],
      useBuiltinTools: false,
    });
    await agent.run("question 1");
    await agent.run("question 2");
    const file = join(root, "sessions", "s1", "messages.jsonl");
    const before = await readFile(file, "utf8");

    await expect(
      agent.compact({ keepRecentTurns: 1, summaryModel: failingProvider() }),
    ).rejects.toThrow("summary failed");
    expect(await readFile(file, "utf8")).toBe(before);
    await agent.dispose();
  });
});
