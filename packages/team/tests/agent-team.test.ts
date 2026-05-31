import { describe, it, expect, vi } from "vitest";
import type { Agent, AgentResult, ModelMessage, ToolCallRecord } from "@walle-agent/core";
import { AgentTeam } from "../src/agent-team.js";
import type { TeamMember } from "../src/team-types.js";

interface FakeAgentSpec {
  name: string;
  outputs?: string[]; // one per call; last one repeats forever
  messages?: ModelMessage[];
  toolCalls?: ToolCallRecord[];
}

function fakeAgent(spec: FakeAgentSpec): Agent {
  let i = 0;
  const outs = spec.outputs ?? [`reply-from-${spec.name}`];
  const run = vi.fn(async (input: string): Promise<AgentResult> => {
    const idx = Math.min(i++, outs.length - 1);
    return {
      content: outs[idx],
      messages: spec.messages ?? [{ role: "assistant", content: outs[idx] }],
      toolCalls: spec.toolCalls ?? [],
      events: [],
    };
  });
  return {
    name: spec.name,
    id: `id-${spec.name}`,
    sessionId: `s-${spec.name}`,
    run,
  } as unknown as Agent;
}

function member(name: string, role: string, agent: Agent, description?: string): TeamMember {
  return { name, role, agent, description };
}

describe("AgentTeam constructor", () => {
  it("throws when members is empty", () => {
    expect(() => new AgentTeam({ members: [] })).toThrow(/at least one member/i);
  });
});

describe("AgentTeam — parallel strategy", () => {
  it("runs every member concurrently and concatenates outputs with member headers", async () => {
    const a = fakeAgent({ name: "A", outputs: ["from-A"] });
    const b = fakeAgent({ name: "B", outputs: ["from-B"] });
    const c = fakeAgent({ name: "C", outputs: ["from-C"] });
    const team = new AgentTeam({
      members: [
        member("A", "alpha-role", a),
        member("B", "beta-role", b),
        member("C", "gamma-role", c),
      ],
    });
    const result = await team.run("solve it", { strategy: "parallel" });

    // Each agent called once with the role-prefixed task.
    expect((a.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("[Your Role: alpha-role]\n\nTask: solve it");
    expect((b.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((c.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

    expect(result.content).toContain("## A (alpha-role)");
    expect(result.content).toContain("## B (beta-role)");
    expect(result.content).toContain("## C (gamma-role)");
    expect(result.content).toContain("from-A");
    expect(result.content).toContain("from-B");
    expect(result.content).toContain("from-C");
  });

  it("flatMaps messages, toolCalls, events from every member into the AgentResult", async () => {
    const tcA: ToolCallRecord = { id: "1", name: "t", input: {}, output: 1, status: "success" };
    const tcB: ToolCallRecord = { id: "2", name: "t", input: {}, output: 2, status: "success" };
    const a = fakeAgent({ name: "A", outputs: ["x"], toolCalls: [tcA] });
    const b = fakeAgent({ name: "B", outputs: ["y"], toolCalls: [tcB] });
    const team = new AgentTeam({
      members: [member("A", "r1", a), member("B", "r2", b)],
    });
    const result = await team.run("task", { strategy: "parallel" });
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map((t) => t.id).sort()).toEqual(["1", "2"]);
    expect(result.messages.length).toBe(2);
  });
});

describe("AgentTeam — pipeline strategy", () => {
  it("executes members in declared order; each agent sees the prior content in its prompt", async () => {
    const a = fakeAgent({ name: "A", outputs: ["A-says-hi"] });
    const b = fakeAgent({ name: "B", outputs: ["B-says-yo"] });
    const c = fakeAgent({ name: "C", outputs: ["C-final"] });
    const team = new AgentTeam({
      members: [member("A", "rA", a), member("B", "rB", b), member("C", "rC", c)],
    });
    const result = await team.run("kickoff", { strategy: "pipeline" });
    expect(result.content).toBe("C-final");

    const promptB = (b.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptB).toContain("[Your Role: rB]");
    expect(promptB).toContain("A-says-hi");

    const promptC = (c.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptC).toContain("B-says-yo");
  });

  it("respects pipelineOrder", async () => {
    const a = fakeAgent({ name: "A", outputs: ["A"] });
    const b = fakeAgent({ name: "B", outputs: ["B"] });
    const team = new AgentTeam({
      members: [member("A", "r", a), member("B", "r", b)],
    });
    const result = await team.run("t", { strategy: "pipeline", pipelineOrder: ["B", "A"] });
    expect(result.content).toBe("A");
    const promptA = (a.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptA).toContain("B");
  });

  it("throws when pipelineOrder references an unknown member", async () => {
    const a = fakeAgent({ name: "A", outputs: ["A"] });
    const team = new AgentTeam({ members: [member("A", "r", a)] });
    await expect(
      team.run("t", { strategy: "pipeline", pipelineOrder: ["A", "ghost"] }),
    ).rejects.toThrow(/unknown member "ghost"/);
  });
});

describe("AgentTeam — debate strategy", () => {
  it("runs maxRounds × members.length agent calls and concatenates rounds in the transcript", async () => {
    const a = fakeAgent({ name: "A", outputs: ["a1", "a2", "a3"] });
    const b = fakeAgent({ name: "B", outputs: ["b1", "b2", "b3"] });
    const team = new AgentTeam({
      members: [member("A", "rA", a), member("B", "rB", b)],
    });
    const result = await team.run("argue", { strategy: "debate", maxRounds: 3 });
    expect((a.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);
    expect((b.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);
    expect(result.content).toContain("## Round 1");
    expect(result.content).toContain("## Round 2");
    expect(result.content).toContain("## Round 3");
    expect(result.content).toContain("### A: a1");
    expect(result.content).toContain("### B: b3");
  });

  it("when a coordinator is provided, returns the coordinator's summary content + aggregates messages/toolCalls/events", async () => {
    const a = fakeAgent({ name: "A", outputs: ["a1"] });
    const b = fakeAgent({ name: "B", outputs: ["b1"] });
    const tcA: ToolCallRecord = { id: "1", name: "t", input: {}, output: null, status: "success" };
    const aTraced = fakeAgent({ name: "A", outputs: ["a1"], toolCalls: [tcA] });
    const tcCoord: ToolCallRecord = { id: "9", name: "t", input: {}, output: null, status: "success" };
    const coord = fakeAgent({ name: "C", outputs: ["FINAL"], toolCalls: [tcCoord] });
    const team = new AgentTeam({
      members: [member("A", "rA", aTraced), member("B", "rB", b)],
      coordinator: coord,
    });
    void a; // keep unused-var quiet
    const result = await team.run("argue", { strategy: "debate", maxRounds: 1 });
    expect(result.content).toBe("FINAL");
    expect((coord.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(result.toolCalls.map((t) => t.id).sort()).toEqual(["1", "9"]);
  });

  it("defaults maxRounds to 3", async () => {
    const a = fakeAgent({ name: "A", outputs: ["a"] });
    const team = new AgentTeam({ members: [member("A", "r", a)] });
    await team.run("t", { strategy: "debate" });
    expect((a.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);
  });
});

describe("AgentTeam — supervisor strategy", () => {
  it("delegates straight to coordinator.run and returns its result", async () => {
    const a = fakeAgent({ name: "A", outputs: ["a"] });
    const coord = fakeAgent({ name: "C", outputs: ["coordinator-answer"] });
    const team = new AgentTeam({
      members: [member("A", "r", a)],
      coordinator: coord,
    });
    const result = await team.run("solve", { strategy: "supervisor" });
    expect(result.content).toBe("coordinator-answer");
    expect((coord.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("solve");
    expect((a.run as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("throws a helpful message when no coordinator is configured", async () => {
    const a = fakeAgent({ name: "A", outputs: ["a"] });
    const team = new AgentTeam({ members: [member("A", "r", a)] });
    await expect(team.run("solve", { strategy: "supervisor" })).rejects.toThrow(
      /createSupervisorTeam/,
    );
  });
});

describe("AgentTeam — unknown strategy", () => {
  it("throws with the bad value in the message", async () => {
    const a = fakeAgent({ name: "A", outputs: ["a"] });
    const team = new AgentTeam({ members: [member("A", "r", a)] });
    await expect(team.run("t", { strategy: "ladder" as any })).rejects.toThrow(/unknown strategy/i);
  });
});
