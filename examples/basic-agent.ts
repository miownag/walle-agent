/**
 * Basic Agent example — non-streaming.
 *
 * Usage:
 *   pnpm --filter examples run basic
 */

import { config } from "dotenv";
import { Agent, defineTool } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";


const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

// Define a simple tool
const calculator = defineTool({
  name: "calculator",
  description: "Evaluate a mathematical expression and return the result.",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "Math expression to evaluate" },
    },
    required: ["expression"],
  },
  riskLevel: "low",
  async execute(input: { expression: string }) {
    try {
      // Simple and safe for demo purposes
      const result = Function(`"use strict"; return (${input.expression})`)();
      return { result: Number(result) };
    } catch (e) {
      return { error: String(e) };
    }
  },
});

async function main() {
  const agent = await Agent.create({
    name: "BasicAgent",
    model: new OpenAIProvider({ model: process.env.MODEL!, baseURL: process.env.BASE_URL!, apiKey: process.env.API_KEY }),
    systemPrompt: "You are a helpful assistant. Use the calculator tool when needed.",
    tools: [calculator],
  });

  console.log("Agent created:", agent.name);

  // Non-streaming run
  const result = await agent.run("What is 42 * 17 + 3?");
  console.log("\nResponse:", result.content);

  if (result.toolCalls.length > 0) {
    console.log("\nTool calls:");
    for (const tc of result.toolCalls) {
      console.log(`  - ${tc.name}(${JSON.stringify(tc.input)}) → ${JSON.stringify(tc.output)}`);
    }
  }

  await agent.dispose();
}

main().catch(console.error);
