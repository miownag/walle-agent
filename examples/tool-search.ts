/**
 * Tool Search example — `tool_search` + `defer_execute_tool`.
 *
 * Demonstrates how a large set of tools is hidden by default and
 * re-discovered by the LLM on demand. Useful when several MCP servers are
 * connected and their combined tool count would otherwise dominate the
 * prompt budget.
 *
 * Usage:
 *   pnpm tool-search
 */

import { config } from "dotenv";
import { Agent, defineTool } from "@walle-agent/core";
import type { Tool } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
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

// Synthesise a fake MCP tool suite: 60 tools tagged ["mcp", "fake"]. When
// `toolSearch.mode === "auto"` and total tool count > threshold (30 by
// default), they are all moved to shadow.
function makeFakeMcpTools(): Tool[] {
  return Array.from({ length: 60 }, (_, i) =>
    defineTool({
      name: `mcp_fake_op_${i}`,
      description: `Fake MCP operation #${i} — ${["read", "write", "list", "search", "transform"][i % 5]} something.`,
      parameters: { type: "object", properties: { x: { type: "string" } } },
      tags: ["mcp", "fake"],
      riskLevel: "low",
      async execute() {
        return `ran mcp_fake_op_${i}`;
      },
    }),
  );
}

async function main() {
  console.log("\n=== Tool Search Demo ===\n");

  const agent = await Agent.create({
    name: "tool-search-demo",
    model: makeModel(),
    tools: makeFakeMcpTools(),
    // Defaults: enabled=true, mode="auto", threshold=30, alwaysShadowTags=["mcp"].
    // Override here only to be explicit.
    toolSearch: {
      enabled: true,
      mode: "auto",
      threshold: 30,
    },
  });

  console.log("Total tools registered:", agent.listVisibleTools().length + agent.listHiddenTools().length);
  console.log("Visible tools:", agent.listVisibleTools().map((t) => t.name).slice(0, 20).join(", "));
  console.log("Hidden tools:", agent.listHiddenTools().length);

  // Encourage the LLM to discover via tool_search.
  const result = await agent.run(
    "I need to perform a search-style operation against the mcp_fake namespace. Find the right tool and execute it.",
  );
  console.log("\n--- Final answer ---\n", result.content);

  await agent.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
