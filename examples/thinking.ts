/**
 * Thinking / Reasoning example (DeepSeek thinking mode via OpenAI-compatible API).
 *
 * Usage:
 *   # .env:
 *   #   API_KEY=sk-xxx
 *   #   BASE_URL=https://api.deepseek.com
 *   #   MODEL=deepseek-v4-pro
 *   pnpm --filter walle-agent-examples run thinking
 *
 * Demonstrates:
 *   - enabling reasoning via `reasoning: { enabled: true, effort: "medium" }`
 *   - streaming `thinking_delta` separately from `text_delta`
 *   - multi-turn (tool call) continuation — reasoning_content echoes back correctly
 */

import { config } from "dotenv";
import { Agent, defineTool } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

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
      const result = Function(`"use strict"; return (${input.expression})`)();
      return { result: Number(result) };
    } catch (e) {
      return { error: String(e) };
    }
  },
});

async function main() {
  const agent = await Agent.create({
    name: "ThinkingAgent",
    model: new OpenAIProvider({
      model: process.env.MODEL!,
      baseURL: process.env.BASE_URL!,
      apiKey: process.env.API_KEY,
      reasoning: { enabled: true, effort: "medium" },
    }),
    systemPrompt: "You are a careful reasoner. Use the calculator tool when needed.",
    tools: [calculator],
  });

  console.log("Thinking example (DeepSeek-style reasoning):");
  console.log("─".repeat(60));

  const stream = agent.run("What is (42 * 17 + 3) / 5?", { stream: true });

  let mode: "thinking" | "text" | null = null;
  for await (const event of stream) {
    switch (event.type) {
      case "llm_chunk": {
        const chunk = event.chunk;
        if (chunk.type === "thinking_delta") {
          if (mode !== "thinking") {
            process.stdout.write("\n[思考] ");
            mode = "thinking";
          }
          process.stdout.write(chunk.content);
        }
        break;
      }
      case "text_delta":
        if (mode !== "text") {
          process.stdout.write("\n[回答] ");
          mode = "text";
        }
        process.stdout.write(event.content);
        break;
      case "tool_call_start":
        mode = null;
        process.stdout.write(
          `\n[调用工具] ${event.call.name}(${JSON.stringify(event.call.arguments)})`,
        );
        break;
      case "tool_call_end":
        process.stdout.write(` → ${JSON.stringify(event.record.output)}\n`);
        break;
    }
  }

  console.log("\n" + "─".repeat(60));
  await agent.dispose();
}

main().catch(console.error);
