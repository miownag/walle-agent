/**
 * EvolutionEngine — observe → reflect → propose → evaluate → approve → apply.
 *
 * Triggers:
 *  1. Explicit remember — user said "记住 X" / "remember that X".
 *  2. Periodic review   — every N runs, distill durable memories.
 *  3. Task review       — after a run with many tool calls, try to extract a Skill.
 *
 * All LLM calls reuse the agent's configured model (or an override). Failures
 * are swallowed: evolution never breaks the parent run.
 */

import type { LLMProvider, ModelMessage } from "@walle-agent/core";
import { MEMORY_EXTRACTION_PROMPT, SKILL_EXTRACTION_PROMPT } from "./prompts.js";
import type {
  EvolutionContext,
  EvolutionEngineDeps,
  EvolutionProposal,
  MemoryProposal,
  SkillProposal,
} from "./evolution-types.js";

const DEFAULT_REMEMBER_PATTERNS: RegExp[] = [
  /记住/i,
  /请记住/i,
  /以后都/i,
  /我的偏好/i,
  /我喜欢/i,
  /\bremember\b/i,
  /keep in mind/i,
  /from now on/i,
  /always use/i,
];

export class EvolutionEngine {
  constructor(private readonly deps: EvolutionEngineDeps) {}

  /**
   * Entry point — invoked once per `run_end` by the plugin. Fires all enabled
   * triggers concurrently. Errors are per-trigger and never propagate out.
   */
  async afterRun(ctx: EvolutionContext): Promise<void> {
    const jobs: Promise<void>[] = [];

    if (this.shouldExplicitRemember(ctx)) {
      jobs.push(this.safe(() => this.handleExplicitRemember(ctx)));
    }
    if (this.shouldPeriodicReview(ctx)) {
      jobs.push(this.safe(() => this.periodicReview(ctx)));
    }
    if (this.shouldTaskReview(ctx)) {
      jobs.push(this.safe(() => this.taskReview(ctx)));
    }

    await Promise.all(jobs);
  }

  private safe(fn: () => Promise<void>): Promise<void> {
    return fn().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[EvolutionEngine] trigger failed:", err);
    });
  }

  // ─── Trigger conditions ───────────────────────────────────────────

  private shouldExplicitRemember(ctx: EvolutionContext): boolean {
    const cfg = this.deps.config.explicitRemember ?? { enabled: true };
    if (cfg.enabled === false) return false;
    const userMsg = lastUserText(ctx.messages);
    if (!userMsg) return false;
    const patterns = cfg.patterns ?? DEFAULT_REMEMBER_PATTERNS;
    return patterns.some((p) => p.test(userMsg));
  }

  private shouldPeriodicReview(ctx: EvolutionContext): boolean {
    const cfg = this.deps.config.periodicReview;
    if (!cfg?.enabled) return false;
    const every = cfg.everyTurns ?? 10;
    return ctx.turnCounter > 0 && ctx.turnCounter % every === 0;
  }

  private shouldTaskReview(ctx: EvolutionContext): boolean {
    const cfg = this.deps.config.taskReview;
    if (!cfg?.enabled) return false;
    const toolMessages = ctx.messages.filter((m) => m.role === "tool");
    const minCalls = cfg.minToolCalls ?? 5;
    return toolMessages.length >= minCalls;
  }

  // ─── Triggers ─────────────────────────────────────────────────────

  private async handleExplicitRemember(ctx: EvolutionContext): Promise<void> {
    // For explicit remember we focus on the most recent exchange.
    const userMsg = lastUserText(ctx.messages) ?? "";
    const asstMsg = lastAssistantText(ctx.messages) ?? "";

    const proposals = await this.extractMemoryProposals(
      JSON.stringify({ user: userMsg, assistant: asstMsg }),
    );

    for (const payload of proposals) {
      await this.commitProposal({
        type: "memory",
        payload,
        reason: "explicit_remember",
        runId: ctx.runId,
        sessionId: ctx.sessionId,
      });
    }
  }

  private async periodicReview(ctx: EvolutionContext): Promise<void> {
    const max = this.deps.config.periodicReview?.maxMessagesInReview ?? 20;
    const recent = ctx.messages.slice(-max);
    const flattened = flattenMessages(recent);

    const proposals = await this.extractMemoryProposals(JSON.stringify(flattened));
    for (const payload of proposals) {
      await this.commitProposal({
        type: "memory",
        payload,
        reason: "periodic_review",
        runId: ctx.runId,
        sessionId: ctx.sessionId,
      });
    }
  }

  private async taskReview(ctx: EvolutionContext): Promise<void> {
    if (!this.deps.skills) return;

    const max = this.deps.config.taskReview?.maxMessagesInReview ?? 30;
    const recent = ctx.messages.slice(-max);
    const flattened = flattenMessages(recent);

    const proposal = await this.extractSkillProposal(JSON.stringify(flattened));
    if (!proposal) return;

    await this.commitProposal({
      type: "skill",
      payload: proposal,
      reason: "task_review",
      runId: ctx.runId,
      sessionId: ctx.sessionId,
    });
  }

  // ─── LLM extraction ───────────────────────────────────────────────

  private reviewer(): LLMProvider {
    return this.deps.config.reviewModel ?? this.deps.model;
  }

  private async extractMemoryProposals(userPayload: string): Promise<MemoryProposal[]> {
    const resp = await this.reviewer().chat({
      responseFormat: "json",
      messages: [
        { role: "system", content: MEMORY_EXTRACTION_PROMPT },
        { role: "user", content: userPayload },
      ],
    });
    const text = extractText(resp.message.content);
    const parsed = safeJson(text);
    if (!parsed || !Array.isArray(parsed.memories)) return [];

    return parsed.memories
      .filter((m: unknown) => isMemoryProposal(m))
      .map((m: MemoryProposal) => normalizeMemoryProposal(m));
  }

  private async extractSkillProposal(userPayload: string): Promise<SkillProposal | null> {
    const resp = await this.reviewer().chat({
      responseFormat: "json",
      messages: [
        { role: "system", content: SKILL_EXTRACTION_PROMPT },
        { role: "user", content: userPayload },
      ],
    });
    const text = extractText(resp.message.content);
    const parsed = safeJson(text);
    if (!parsed || !parsed.skill || !isSkillProposal(parsed.skill)) return null;
    return normalizeSkillProposal(parsed.skill);
  }

  // ─── Commit & apply ───────────────────────────────────────────────

  private async commitProposal(
    proposal: Omit<EvolutionProposal, "id" | "createdAt" | "status">,
  ): Promise<void> {
    const cfg =
      proposal.type === "memory"
        ? this.deps.config.memoryCreation ?? { enabled: true }
        : this.deps.config.skillCreation ?? { enabled: true };

    if (cfg.enabled === false) return;

    // Gates — importance / confidence.
    if (proposal.type === "memory") {
      const mem = proposal.payload as MemoryProposal;
      const mc = this.deps.config.memoryCreation;
      if (mem.importance < (mc?.minImportance ?? 0.5)) return;
      if (mem.confidence < (mc?.minConfidence ?? 0.5)) return;
    } else {
      const skill = proposal.payload as SkillProposal;
      const sc = this.deps.config.skillCreation;
      if (skill.confidence < (sc?.minConfidence ?? 0.7)) return;
    }

    // Always notify observers.
    const staged: EvolutionProposal = {
      ...proposal,
      createdAt: new Date().toISOString(),
      status: "pending",
    };

    if (this.deps.config.onProposal) {
      try {
        await this.deps.config.onProposal(staged);
      } catch {
        // swallow — observer errors must not break evolution.
      }
    }

    const requireApproval =
      proposal.type === "memory"
        ? this.deps.config.memoryCreation?.requireApproval ?? false
        : this.deps.config.skillCreation?.requireApproval ?? true;

    if (requireApproval) {
      if (this.deps.config.approvalHandler) {
        const approved = await this.deps.config.approvalHandler(staged);
        if (!approved) return;
      } else {
        // Write to disk for offline review; do not apply.
        await this.deps.proposalStore.enqueue(staged);
        return;
      }
    }

    // Auto-apply path: persist + apply.
    const persisted = await this.deps.proposalStore.enqueue(staged);
    try {
      await this.applyProposal(persisted);
      await this.deps.proposalStore.markApplied(persisted.id!);
    } catch (err) {
      // Leave in pending; operators can retry later.
      // eslint-disable-next-line no-console
      console.error("[EvolutionEngine] failed to apply proposal:", err);
    }
  }

  /**
   * Apply a single approved proposal. Safe to call externally (e.g. from a
   * CLI that reads the proposal queue and approves selectively).
   */
  async applyProposal(proposal: EvolutionProposal): Promise<void> {
    if (proposal.type === "memory") {
      const mem = proposal.payload as MemoryProposal;
      await this.deps.memory.remember({
        type: mem.type,
        scope: mem.scope === "mid" || mem.scope === "long" ? mem.scope : "long",
        content: mem.content,
        importance: mem.importance,
        confidence: mem.confidence,
        tags: mem.tags,
      });
      return;
    }

    if (proposal.type === "skill" && this.deps.skills) {
      const skill = proposal.payload as SkillProposal;
      await this.deps.skills.register({
        id: newId(),
        name: skill.name,
        description: skill.description,
        type: "prompt",
        content: skill.content,
        tags: skill.tags,
        trigger: {
          examples: skill.triggerExamples,
          keywords: skill.triggerKeywords ?? skill.tags,
        },
        metadata: {
          createdBy: "agent",
          createdAt: new Date().toISOString(),
          usageCount: 0,
          successCount: 0,
          confidence: skill.confidence,
        },
      });
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function lastUserText(messages: ModelMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return plainText(m.content);
  }
  return null;
}

function lastAssistantText(messages: ModelMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") return plainText(m.content);
  }
  return null;
}

function plainText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `[tool_use ${block.name}]`;
      if (block.type === "tool_result")
        return typeof block.content === "string" ? block.content : "[tool_result]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function flattenMessages(messages: ModelMessage[]): Array<{ role: string; content: string }> {
  return messages.map((m) => ({ role: m.role, content: plainText(m.content) }));
}

function extractText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}

function safeJson(text: string): any {
  if (!text) return null;
  // strip ```json fences if present
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    // attempt to pull out the first JSON object
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function isMemoryProposal(v: unknown): v is MemoryProposal {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.content === "string" && typeof o.type === "string";
}

function isSkillProposal(v: unknown): v is SkillProposal {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === "string" && typeof o.content === "string";
}

function normalizeMemoryProposal(m: MemoryProposal): MemoryProposal {
  return {
    type: (m.type ?? "fact") as MemoryProposal["type"],
    content: m.content,
    importance: clamp01(m.importance ?? 0.5),
    confidence: clamp01(m.confidence ?? 0.8),
    scope: m.scope === "mid" ? "mid" : "long",
    tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === "string") : undefined,
  };
}

function normalizeSkillProposal(s: SkillProposal): SkillProposal {
  return {
    name: s.name,
    description: s.description ?? "",
    content: s.content,
    tags: Array.isArray(s.tags) ? s.tags.filter((t) => typeof t === "string") : undefined,
    confidence: clamp01(s.confidence ?? 0.7),
    triggerExamples: s.triggerExamples,
    triggerKeywords: s.triggerKeywords,
  };
}

function clamp01(v: number): number {
  if (typeof v !== "number" || Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
