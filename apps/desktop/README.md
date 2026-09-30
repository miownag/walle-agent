# Walle Desktop

Local-only coding Agent desktop application powered by the Walle Agent SDK.

## Development

From the monorepo root:

```bash
pnpm install
pnpm desktop:dev
```

The app intentionally starts without credentials. Add a Provider profile in **Settings → Providers**, or use `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` as a local environment fallback.

## Verification

```bash
pnpm --filter @walle-agent/desktop typecheck
pnpm --filter @walle-agent/desktop test
pnpm desktop:build
# Optional packaging, outside the local-dev acceptance scope:
pnpm --filter @walle-agent/desktop package:mac
```

## Local data

Threads, UI timelines, settings, memories, Skills, traces, RAG data, and Evolution proposals are stored below Electron's local `userData` directory. Provider secrets are encrypted with Electron `safeStorage` when the operating system supports it and are never exposed to the renderer.

The renderer has no Node integration. Filesystem, shell, Provider, MCP, and Agent operations remain in Electron main and cross a narrow typed preload bridge.
