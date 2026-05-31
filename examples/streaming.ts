/**
 * Streaming Agent example.
 *
 * Usage:
 *   pnpm --filter walle-agent-examples run stream
 */

import { config } from "dotenv";
import { Agent, defineTool } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

const webSearch = defineTool({
  name: "web_search",
  description: "Search the web for recent information.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
  async execute(input: { query: string }) {
    // Mock search result for demo
    return {
      results: [
        { title: "Example Result", snippet: `Mock result for: ${input.query}` },
      ],
    };
  },
});

async function main() {
  const agent = await Agent.create({
    name: "StreamAgent",
    model: new OpenAIProvider({ model: process.env.MODEL!, baseURL: process.env.BASE_URL!, apiKey: process.env.API_KEY }),
    systemPrompt: "You are a helpful assistant with web search capabilities.",
    tools: [webSearch],
    hooks: {
      beforeModelCall() {
        process.stdout.write("\n[LLM thinking...]\n");
      },
    },
  });

  console.log("Streaming example:");
  console.log("─".repeat(40));

  // Streaming run
  const stream = agent.run("Hello, world!", { stream: true });

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        process.stdout.write(event.content);
        break;
      case "tool_call_start":
        process.stdout.write(`\n[Calling: ${event.call.name}(${JSON.stringify(event.call.arguments)})]\n`);
        break;
      case "tool_call_end":
        process.stdout.write(`[Result: ${event.record.status}]\n`);
        break;
    }
  }

  console.log("\n" + "─".repeat(40));
  console.log("Stream complete.");

  await agent.dispose();
}

main().catch(console.error);
