import { describe, it, expect, vi } from "vitest";
import type { Agent, AgentResult } from "@walle-agent/core";
import { Swarm } from "../src/swarm.js";
import { Blackboard } from "../src/blackboard.js";
import type { SwarmPolicy, SwarmState, TeamMember } from "../src/team-types.js";

function fakeAgent(name: string, content: string): Agent {
  const result: AgentResult = { content, messages: [], toolCalls: [], events: [] };
  return {
    name,
    id: `id-${name}`,
    sessionId: `s-${name}`,
    run: vi.fn(async () => result),
  } as unknown as Agent;
}

function member(name: string, agent: Agent): TeamMember {
  return { name, role: "r", agent };
}

describe("Swarm constructor", () => {
  it("rejects empty members list", () => {
    const policy: SwarmPolicy = {
      shouldContinue: async () => false,
      selectAgents: async () => [],
    };
    expect(() => new Swarm([], policy)).toThrow(/at least one TeamMember/i);
  });
});

describe("Swarm.run", () => {
  it("runs N rounds while shouldContinue returns true; posts every output to the blackboard", async () => {
    const a = fakeAgent("A", "a-out");
    const b = fakeAgent("B", "b-out");
    const members = [member("A", a), member("B", b)];

    let rounds = 0;
    const policy: SwarmPolicy = {
      async shouldContinue() {
        return rounds++ < 2;
      },
      async selectAgents(_t, _s, all) {
        return all;
      },
    };

    const bb = new Blackboard();
    const swarm = new Swarm(members, policy, bb);
    const result = await swarm.run("the task");

    expect((a.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    expect((b.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    expect(bb.getEntries()).toHaveLength(4); // 2 rounds × 2 members

    expect(result.content).toContain("## A\na-out");
    expect(result.content).toContain("## B\nb-out");
  });

  it("breaks early when selectAgents returns an empty array", async () => {
    const a = fakeAgent("A", "x");
    const policy: SwarmPolicy = {
      shouldContinue: async () => true,
      selectAgents: async () => [],
    };
    const swarm = new Swarm([member("A", a)], policy);
    const result = await swarm.run("task");
    expect((a.run as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // Default final content from empty blackboard is "".
    expect(result.content).toBe("");
  });

  it("uses policy.synthesize when provided", async () => {
    const a = fakeAgent("A", "ignored");
    let rounds = 0;
    const policy: SwarmPolicy = {
      async shouldContinue() {
        return rounds++ < 1;
      },
      async selectAgents(_t, _s, all) {
        return all;
      },
      async synthesize(state: SwarmState) {
        return `final after ${state.rounds.length} rounds`;
      },
    };
    const swarm = new Swarm([member("A", a)], policy);
    const result = await swarm.run("task");
    expect(result.content).toBe("final after 1 rounds");
  });

  it("populates state.rounds with monotonic indices and the agents who ran", async () => {
    const a = fakeAgent("A", "x");
    const b = fakeAgent("B", "y");
    const members = [member("A", a), member("B", b)];

    let rounds = 0;
    const calls: number[] = [];
    const policy: SwarmPolicy = {
      async shouldContinue() {
        return rounds++ < 2;
      },
      async selectAgents(_t, state, all) {
        calls.push(state.rounds.length);
        return rounds === 1 ? [all[0]] : [all[1]]; // 1st round picks A, 2nd picks B
      },
    };
    const swarm = new Swarm(members, policy);
    await swarm.run("task");
    expect(calls).toEqual([0, 1]);
  });

  it("aggregates messages/toolCalls/events from each agent run", async () => {
    const result1: AgentResult = {
      content: "x",
      messages: [{ role: "assistant", content: "x" }],
      toolCalls: [{ id: "t1", name: "t", input: {}, output: null, status: "success" }],
      events: [],
    };
    const a = {
      name: "A",
      id: "id-A",
      sessionId: "s",
      run: vi.fn(async () => result1),
    } as unknown as Agent;

    let rounds = 0;
    const policy: SwarmPolicy = {
      async shouldContinue() {
        return rounds++ < 1;
      },
      async selectAgents(_t, _s, all) {
        return all;
      },
    };
    const swarm = new Swarm([member("A", a)], policy);
    const out = await swarm.run("t");
    expect(out.toolCalls).toHaveLength(1);
    expect(out.messages).toHaveLength(1);
  });
});
