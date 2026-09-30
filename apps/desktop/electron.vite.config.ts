import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const bundledWallePackages = [
  "@walle-agent/anthropic",
  "@walle-agent/core",
  "@walle-agent/evolution",
  "@walle-agent/mcp",
  "@walle-agent/memory",
  "@walle-agent/openai",
  "@walle-agent/rag",
  "@walle-agent/sandbox",
  "@walle-agent/skills",
  "@walle-agent/team",
  "@walle-agent/trace",
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWallePackages })],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
