/**
 * Trace example — wire the trace plugin, run an agent, then read back the
 * recorded events. Stores them under `./.walle/traces/<date>.jsonl`.
 *
 * Usage:
 *   pnpm --filter examples run trace
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
import { TracePlugin } from "@walle-agent/trace";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

async function main() {
  const tracesDir = resolve(__dirname, "..", ".walle", "traces");
  const trace = new TracePlugin({
    store: "jsonl",
    storePath: tracesDir,
    recordContent: true, // Demo only — flip off for prod.
  });

  const agent = await Agent.create({
    name: "Traced",
    model: new OpenAIProvider({
      model: process.env.MODEL!,
      baseURL: process.env.BASE_URL!,
      apiKey: process.env.API_KEY,
    }),
    systemPrompt: "You are concise.",
    plugins: [trace],
  });

  const result = await agent.run("Say hi in one word.");
  console.log(`assistant → ${result.content}`);

  // Pull back what was recorded.
  const traceId = trace.getCurrentTraceId();
  if (traceId) {
    const events = await trace.getStore().getTrace(traceId);
    console.log(`\nrecorded ${events.length} trace events for ${traceId}:`);
    for (const ev of events) {
      console.log(`  ${ev.timestamp}  ${ev.type}  ${JSON.stringify(ev.data).slice(0, 120)}`);
    }
  }

  await agent.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
