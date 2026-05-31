/**
 * Evolution example — demonstrates all three evolution triggers:
 *   1. Explicit remember     — user says "remember that...", memory auto-written.
 *   2. Periodic review       — every N runs, memories are distilled.
 *   3. Task review           — after a multi-tool-call task, a Skill proposal lands in the queue.
 *
 * Usage:
 *   pnpm --filter walle-agent-examples run evolution
 *
 * Requires `examples/.env` with:
 *   API_KEY=sk-xxx
 *   BASE_URL=https://api.openai.com/v1
 *   MODEL=gpt-4o-mini
 */

import { config } from "dotenv";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { Agent } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { MemoryPlugin } from "@walle-agent/memory";
import { SkillsPlugin } from "@walle-agent/skills";
import { EvolutionPlugin } from "@walle-agent/evolution";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

async function main() {
  const walleDir = resolve(__dirname, "..", ".walle-evolution");
  const sessionId = `evol-${Date.now()}`;

  const memoryPlugin = new MemoryPlugin({ rootDir: walleDir });
  const skillsPlugin = new SkillsPlugin({ project: resolve(walleDir, "agents") });
  const evolutionPlugin = new EvolutionPlugin({
    rootDir: resolve(walleDir, "evolution"),
    // Trigger memory extraction whenever the user says "remember ..." or similar.
    explicitRemember: { enabled: true },
    // Periodic review is usually gated for demo runs — kept off here for brevity.
    periodicReview: { enabled: false },
    // Task review fires when a conversation had >=3 tool calls.
    taskReview: { enabled: true, minToolCalls: 3 },
    // Memories are applied automatically; skills require approval.
    memoryCreation: { enabled: true, requireApproval: false, minImportance: 0.4 },
    skillCreation: { enabled: true, requireApproval: true, minConfidence: 0.6 },
    onProposal: async (p) => {
      console.log(`   ⚙️  proposal [${p.type}] reason=${p.reason}`);
    },
  });

  const agent = await Agent.create({
    name: "EvolvingWalle",
    model: new OpenAIProvider({
      model: process.env.MODEL!,
      baseURL: process.env.BASE_URL!,
      apiKey: process.env.API_KEY,
    }),
    systemPrompt:
      "You are a self-evolving assistant. Use the `remember` tool to store durable " +
      "preferences the user teaches you, and `recall` to check memory. Answer concisely.",
    plugins: [memoryPlugin, skillsPlugin, evolutionPlugin],
  });

  console.log("\n1️⃣  Explicit remember");
  console.log("── user → Please remember: I use pnpm, never npm.");
  const r1 = await agent.run("Please remember: I use pnpm, never npm.", { sessionId });
  console.log(`── assistant → ${r1.content}`);

  // Give evolution a moment to finish extracting in the background.
  await new Promise((r) => setTimeout(r, 2000));
  const mems = await memoryPlugin.manager.list();
  console.log(`   memories in long-term memory: ${mems.length}`);
  for (const m of mems) {
    console.log(`     • [${m.type}] ${m.content}`);
  }

  console.log("\n2️⃣  Ask a follow-up — memory should influence the answer");
  const r2 = await agent.run("Which package manager should I use?", { sessionId });
  console.log(`── assistant → ${r2.content}`);

  console.log("\n3️⃣  Pending skill proposals (if any):");
  const pending = await evolutionPlugin.pending();
  if (pending.length === 0) {
    console.log("   (none)");
  } else {
    for (const p of pending) {
      console.log(`   • [${p.type}] ${(p.payload as any).name ?? (p.payload as any).content}`);
      console.log(`     reason=${p.reason}  confidence=${(p.payload as any).confidence}`);
    }
    console.log("   → call evolutionPlugin.approveAndApply(id) to accept.");
  }

  await agent.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
