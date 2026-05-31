import { describe, it, expect, vi } from "vitest";
import type {
  Agent,
  AgentResult,
  LLMChatRequest,
  LLMChatResponse,
  LLMProvider,
  LLMStreamChunk,
} from "@walle-agent/core";
import { createSupervisorTeam } from "../src/create-supervisor.js";
import type { TeamMember } from "../src/team-types.js";

class StubProvider implements LLMProvider {
  name = "stub";
  public calls: LLMChatRequest[] = [];
  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.calls.push(request);
    return {
      message: { role: "assistant", content: "[stub]" },
      toolCalls: [],
    };
  }
  async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    this.calls.push(request);
    const message = { role: "assistant" as const, content: "[stub]" };
    yield { type: "text_delta", content: "[stub]" };
    yield { type: "message_complete", message, toolCalls: [] };
  }
}

function fakeAgent(name: string): Agent {
  const result: AgentResult = { content: `${name}-out`, messages: [], toolCalls: [], events: [] };
  return {
    name,
    id: `id-${name}`,
    sessionId: `s-${name}`,
    run: vi.fn(async () => result),
  } as unknown as Agent;
}

function member(name: string, role: string, description?: string): TeamMember {
  return { name, role, description, agent: fakeAgent(name) };
}

describe("createSupervisorTeam", () => {
  it("builds a coordinator whose registered tools include one delegate_* tool per member", async () => {
    const provider = new StubProvider();
    const team = await createSupervisorTeam({
      members: [member("Researcher", "research"), member("Coder", "implement")],
      coordinator: { model: provider },
    });

    // Trigger one coordinator turn so we can inspect the tools the LLM sees.
    await team.run("solve it", { strategy: "supervisor" });

    expect(provider.calls.length).toBeGreaterThan(0);
    const toolNames = (provider.calls[0].tools ?? []).map((t) => t.function.name);
    expect(toolNames).toContain("delegate_researcher");
    expect(toolNames).toContain("delegate_coder");
  });

  it("auto-generated systemPrompt lists every member with name, role and description", async () => {
    const provider = new StubProvider();
    const team = await createSupervisorTeam({
      members: [
        member("Researcher", "research the problem", "uses web search"),
        member("Coder", "implement the solution"),
      ],
      coordinator: { model: provider },
    });

    await team.run("solve it", { strategy: "supervisor" });

    const sys = provider.calls[0].messages.find((m) => m.role === "system");
    expect(sys, "expected a system message").toBeDefined();
    const sysText = typeof sys!.content === "string"
      ? sys!.content
      : JSON.stringify(sys!.content);
    expect(sysText).toContain("Researcher: research the problem — uses web search");
    expect(sysText).toContain("Coder: implement the solution");
    expect(sysText).toContain("delegate_*");
  });

  it("honours coordinator.name and coordinator.systemPrompt overrides", async () => {
    const provider = new StubProvider();
    const team = await createSupervisorTeam({
      members: [member("A", "alpha")],
      coordinator: {
        name: "MyBoss",
        model: provider,
        systemPrompt: "be terse.",
      },
    });

    await team.run("t", { strategy: "supervisor" });
    const sys = provider.calls[0].messages.find((m) => m.role === "system");
    expect(sys?.content).toContain("be terse.");
    expect(sys?.content).not.toContain("delegate_*");
  });

  it("rejects empty members list", async () => {
    const provider = new StubProvider();
    await expect(
      createSupervisorTeam({ members: [], coordinator: { model: provider } }),
    ).rejects.toThrow(/at least one member/i);
  });
});
