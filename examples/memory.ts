/**
 * Memory example — two runs sharing a session, plus long-term memory retrieval.
 *
 * Usage:
 *   pnpm --filter examples run memory
 *
 * Requires `examples/.env` with:
 *   API_KEY=sk-xxx
 *   BASE_URL=https://api.openai.com/v1   (or any OpenAI-compatible endpoint)
 *   MODEL=gpt-4o-mini
 */

import { config } from "dotenv";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { Agent } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { MemoryPlugin } from "@walle-agent/memory";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

async function run(sessionId: string, input: string) {
  const agent = await Agent.create({
    name: "MemoryAgent",
    model: new OpenAIProvider({
      model: process.env.MODEL!,
      baseURL: process.env.BASE_URL!,
      apiKey: process.env.API_KEY,
    }),
    systemPrompt:
      "You are a helpful assistant. Use the `remember` tool to save durable user preferences, " +
      "`recall` to look them up, and `forget` to remove them. Answer concisely.",
    plugins: [
      new MemoryPlugin({
        rootDir: resolve(__dirname, "..", ".walle"),
        largeToolResults: { thresholdChars: 20_000 },
      }),
    ],
  });

  console.log(`\n── [${sessionId}] user → ${input}`);
  const result = await agent.run(input, { sessionId });
  console.log(`── [${sessionId}] assistant → ${result.content}`);
  if (result.toolCalls.length) {
    for (const tc of result.toolCalls) {
      console.log(`   tool: ${tc.name}(${JSON.stringify(tc.input)}) → ${JSON.stringify(tc.output)}`);
    }
  }

  await agent.dispose();
}

async function main() {
  const sessionId = `demo-${Date.now()}`;

  // Turn 1: ask to remember something.
  await run(sessionId, "Please remember that I prefer TypeScript over JavaScript for new projects.");

  // Turn 2: the agent should see the prior turn AND be able to recall the preference.
  await run(sessionId, "What language should I use for a new side project?");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
