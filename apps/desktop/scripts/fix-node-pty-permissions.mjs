import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("node-pty/package.json"));
  const helper = join(
    packageRoot,
    "prebuilds",
    `darwin-${process.arch}`,
    "spawn-helper",
  );
  await chmod(helper, 0o755);
  console.log(`Ensured node-pty spawn-helper is executable (${process.arch})`);
}
