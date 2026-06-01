/**
 * Context Compression example — micro + macro.
 *
 * Demonstrates:
 *   1. Micro compression: tool results from older turns are replaced with
 *      placeholders ("[ToolResult #N evicted | ...]") and can be re-read on
 *      demand via `read_tool_result`.
 *   2. Macro compression: when configured, the agent summarises the head
 *      region of the conversation between turns once token usage exceeds a
 *      threshold. Also exposed as a manual API: `agent.compact()`.
 *
 * Usage:
 *   pnpm compaction
 */

import { config } from "dotenv";
import { Agent } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { MemoryPlugin } from "@walle-agent/memory";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

function makeModel() {
  return new OpenAIProvider({
    model: process.env.MODEL!,
    baseURL: process.env.BASE_URL!,
    apiKey: process.env.API_KEY,
  });
}

async function main() {
  console.log("\n=== Context Compression Demo ===\n");

  const agent = await Agent.create({
    name: "compaction-demo",
    model: makeModel(),
    plugins: [
      new MemoryPlugin({
        rootDir: "./.walle-demo",
        toolResults: {
          // Default: every tool result lands on disk.
          // The most recent 3 assistant turns stay verbatim in the live
          // messages array; older ones are turned into placeholders.
          keepRecentTurns: 3,
          previewHeadLines: 5,
          previewTailLines: 5,
        },
      }),
    ],
    macroCompression: {
      enabled: true,
      threshold: 0.8,        // when est tokens > 80% of maxContextTokens
      keepRecentTurns: 3,
    },
    tokenBudget: { maxContextTokens: 16_000, completionReserve: 2_000 },
  });

  console.log("Visible tools:", agent.listVisibleTools().map((t) => t.name).join(", "));
  console.log("Hidden tools:", agent.listHiddenTools().length);

  // Trigger several turns by asking the agent to do filesystem-heavy work.
  // (The actual tool selection is up to the LLM; this demo just shows the
  // wiring.)
  const result = await agent.run(
    "List the files in the current directory, then read README.md, then run a quick `pwd`. Keep your final answer short.",
    { sessionId: "demo-session" },
  );
  console.log("\n--- Final answer ---\n", result.content);

  // Manual macro compaction.
  if (!agent.isRunning) {
    const { summary, beforeMessages, afterMessages, beforeTokens, afterTokens } =
      await agent.compact();
    console.log("\n--- Manual compact() ---");
    console.log(`messages: ${beforeMessages} → ${afterMessages}`);
    console.log(`tokens:   ${beforeTokens} → ${afterTokens}`);
    if (summary) console.log("summary preview:", summary.slice(0, 200));
  }

  await agent.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
