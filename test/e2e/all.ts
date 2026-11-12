// Runs every browser spec, each in its own fixture and its own lab, and exits non-zero if any of
// them failed.
//
//   npm run test:e2e

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// screenshots.ts drives the same harness but asserts nothing: it is a capture tool, not a spec.
const NOT_SPECS = new Set(["all.ts", "harness.ts", "screenshots.ts"]);
const specs = readdirSync(HERE)
  .filter((file) => file.endsWith(".ts") && !NOT_SPECS.has(file))
  .sort();

let failed = 0;
for (const spec of specs) {
  const code = await new Promise<number | null>((resolve) => {
    spawn(process.execPath, [join(HERE, spec)], { stdio: "inherit" }).on("exit", resolve);
  });
  if (code !== 0) failed++;
}

console.log(failed ? `${failed} of ${specs.length} specs failed` : `${specs.length} specs passed`);
process.exitCode = failed ? 1 : 0;
