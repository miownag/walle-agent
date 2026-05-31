/**
 * RAG example — load a small knowledge base, then ask a question whose
 * answer should be drawn from the indexed files.
 *
 * Usage:
 *   pnpm --filter examples run rag
 *
 * Requires `examples/.env` with:
 *   API_KEY=sk-xxx
 *   BASE_URL=https://api.openai.com/v1
 *   MODEL=gpt-4o-mini
 */

import { config } from "dotenv";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { mkdir, writeFile } from "node:fs/promises";
import { Agent } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { SimpleRAGPlugin } from "@walle-agent/rag";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

async function seedKnowledgeBase(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "deploy.md"),
    [
      "# Deployment",
      "",
      "We deploy via GitHub Actions. The pipeline runs `pnpm build`, then",
      "`docker build` against the project's Dockerfile, and finally pushes",
      "the image to GHCR with the commit SHA as the tag. The production",
      "rollout is gated by an approval step in the `prod-release` workflow.",
    ].join("\n"),
  );
  await writeFile(
    resolve(dir, "support.md"),
    [
      "# Support runbook",
      "",
      "If a customer reports a checkout failure, check the Stripe webhook",
      "log first; 90% of failures are caused by stale signing secrets.",
      "Rotate via `pnpm secrets:rotate stripe-webhook` and redeploy.",
    ].join("\n"),
  );
}

async function main() {
  const docsPath = resolve(__dirname, "..", ".walle", "rag-docs");
  await seedKnowledgeBase(docsPath);

  const agent = await Agent.create({
    name: "RAG-Agent",
    model: new OpenAIProvider({
      model: process.env.MODEL!,
      baseURL: process.env.BASE_URL!,
      apiKey: process.env.API_KEY,
    }),
    systemPrompt:
      "You are a knowledgeable assistant. Use the [Knowledge] context items injected into your prompt as the source of truth.",
    plugins: [
      new SimpleRAGPlugin({
        docsPath,
        patterns: ["**/*.md"],
        chunkSize: 500,
        chunkOverlap: 80,
      }),
    ],
  });

  for (const q of [
    "How do we deploy to production?",
    "A customer says checkout is failing. What do I check first?",
  ]) {
    console.log(`\n── user → ${q}`);
    const r = await agent.run(q);
    console.log(`── assistant → ${r.content}`);
  }

  await agent.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
