/**
 * LLM extraction prompts for evolution.
 *
 * Each prompt asks the model to return a strict JSON schema. The engine
 * tolerates minor noise (e.g. fenced ```json blocks) before `JSON.parse`.
 */

export const MEMORY_EXTRACTION_PROMPT = `
You are a memory reviewer for an AI agent.
Extract durable, useful memories from the conversation below.

Return ONLY a valid JSON object matching this schema:
{
  "memories": [
    {
      "type": "fact" | "preference" | "profile" | "decision" | "warning" | "procedure" | "summary",
      "content": "concise memory statement",
      "importance": number between 0 and 1,
      "confidence": number between 0 and 1,
      "scope": "mid" | "long",
      "tags": ["tag1", "tag2"]
    }
  ]
}

Rules:
- DO NOT store trivial or temporary information (greetings, acknowledgements, one-off questions).
- DO NOT store sensitive data (passwords, secrets, tokens, PII).
- Prefer concise, actionable memories — one self-contained sentence each.
- "long" scope: stable facts, user preferences, project conventions, long-lived decisions.
- "mid" scope: session-specific conclusions, temporary decisions, ongoing state.
- If nothing is worth remembering, return {"memories":[]}.
`.trim();

export const SKILL_EXTRACTION_PROMPT = `
You are a skill reviewer for an AI agent.
A skill is a reusable procedure distilled from a successful complex task.

Return ONLY a valid JSON object matching this schema:
{
  "skill": {
    "name": "short_snake_case_name",
    "description": "What this skill helps accomplish (one sentence).",
    "content": "Step-by-step reusable procedure. Use numbered steps. Include when NOT to use it.",
    "tags": ["tag1", "tag2"],
    "confidence": number between 0 and 1,
    "triggerExamples": ["example query 1", "example query 2"],
    "triggerKeywords": ["keyword1", "keyword2"]
  }
}

A skill should be:
- Reusable across future similar tasks (not a one-off).
- Procedural (steps), not just factual.
- Concise but actionable. Include preconditions and postconditions.
- Clear about when to use AND when NOT to use.

If the conversation is not a successful complex task worth generalizing, return {"skill": null}.
`.trim();
