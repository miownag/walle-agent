/**
 * MCP example — spins up the official filesystem MCP server over stdio and
 * lets an Agent call its tools.
 *
 * Usage:
 *   pnpm --filter examples run mcp
 *
 * Requires `examples/.env` with:
 *   API_KEY=sk-xxx
 *   BASE_URL=https://api.openai.com/v1   (or any OpenAI-compatible endpoint)
 *   MODEL=gpt-4o-mini
 *
 * The filesystem server is fetched on demand via `npx`; the first run may
 * take a few seconds.
 */

import { config } from "dotenv";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { mkdir, writeFile } from "node:fs/promises";

import { Agent } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { MCPPlugin } from "@walle-agent/mcp";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

async function main() {
  const workspace = resolve(__dirname, "..", ".walle", "mcp-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    resolve(workspace, "README.md"),
    "# MCP demo workspace\n\nHello from the MCP example.\n",
    "utf-8",
  );
  await writeFile(
    resolve(workspace, "notes.txt"),
    "Ship Phase 3 MCP slice.\nFollow-ups: sandbox + permissions.\n",
    "utf-8",
  );

  const agent = await Agent.create({
    name: "MCPAgent",
    model: new OpenAIProvider({
      model: process.env.MODEL!,
      baseURL: process.env.BASE_URL!,
      apiKey: process.env.API_KEY,
    }),
    systemPrompt:
      "You are a helpful assistant. Use the available MCP filesystem tools " +
      "(names are prefixed with `mcp_filesystem_`) to answer questions about " +
      "the workspace. Do not guess — always call a tool before answering.",
    plugins: [
      new MCPPlugin([
        {
          name: "filesystem",
          transport: {
            type: "stdio",
            command: "npx",
            args: [
              "-y",
              "@modelcontextprotocol/server-filesystem",
              workspace,
            ],
          },
        },
      ]),
    ],
  });

  console.log("Agent created:", agent.name);
  console.log("Workspace:", workspace);

  const result = await agent.run(
    "List the files in the workspace and summarise what's inside each.",
  );

  console.log("\nResponse:\n" + result.content);

  if (result.toolCalls.length) {
    console.log("\nTool calls:");
    for (const tc of result.toolCalls) {
      console.log(
        `  - ${tc.name}(${JSON.stringify(tc.input)}) → ${String(tc.output).slice(0, 120)}…`,
      );
    }
  }

  await agent.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
