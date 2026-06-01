/**
 * Sub-Agents example — built-in `task` tool dispatch.
 *
 * Demonstrates two equivalent entry points:
 *
 *   1) AgentConfig.subAgents — sugar on Agent.create()
 *   2) SubAgentsPlugin       — plugin form, from @walle-agent/team
 *
 * Both wire into the per-Agent SubAgentRegistry consumed by the built-in
 * `task` tool. The parent LLM dispatches with:
 *
 *   { subagent_type: "researcher", description: "find X", prompt: "…" }
 *
 * and only sees the sub-agent's final summary — no intermediate tool
 * messages bubble up.
 *
 * Usage:
 *   pnpm sub-agents
 */

import { config } from "dotenv";
import { Agent } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { SubAgentsPlugin } from "@walle-agent/team";
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

async function variantSugar() {
  console.log("\n=== Variant 1: AgentConfig.subAgents (sugar) ===\n");

  const agent = await Agent.create({
    name: "Walle",
    model: makeModel(),
    systemPrompt:
      "You are a helpful coordinator. When a sub-task is best handled by " +
      "a specialist, dispatch it via the `task` tool with the right " +
      "`subagent_type`. Otherwise answer directly.",
    subAgents: [
      {
        type: "researcher",
        description: "Web research and concise summarization",
        systemPrompt:
          "You are a research specialist. Produce a 200-word evidence-based " +
          "summary in plain English.",
      },
      {
        type: "code-reviewer",
        description: "Review code snippets for bugs and style issues",
        systemPrompt:
          "You are a senior code reviewer. Return a bullet list of concrete " +
          "issues with severity (critical / high / medium / low).",
      },
    ],
  });

  const result = await agent.run(
    "请用 task 工具让 researcher 帮我总结一下 LRU 缓存淘汰算法的优劣势。",
  );

  console.log("Final answer:\n", result.content);
  console.log("\nTool calls:");
  for (const tc of result.toolCalls) {
    console.log(`  - ${tc.name}(${JSON.stringify(tc.input)}) → ${JSON.stringify(tc.output)}`);
  }

  await agent.dispose();
}

async function variantPlugin() {
  console.log("\n=== Variant 2: SubAgentsPlugin ===\n");

  const agent = await Agent.create({
    name: "Walle",
    model: makeModel(),
    plugins: [
      new SubAgentsPlugin({
        types: [
          {
            type: "researcher",
            description: "Web research",
            systemPrompt: "You are a research specialist.",
          },
        ],
      }),
    ],
  });

  const result = await agent.run(
    "用 task 工具调用 researcher 写一句话总结什么是 ARC cache。",
  );

  console.log("Final answer:\n", result.content);
  await agent.dispose();
}

async function main() {
  await variantSugar();
  await variantPlugin();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
