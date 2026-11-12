// Builds the page into dist/: src/app.ts bundled by esbuild, beside index.html and styles.css.
//
//   node scripts/build.ts                  # one minified build
//   node scripts/build.ts --watch          # rebuild on every change, unminified
//   node scripts/build.ts --watch --serve  # and run the local server against dist/
//
// The bundle is the only thing the browser runs, so a type error is not a build error here:
// `npm run typecheck` owns types, and this owns turning what type-checks into what a browser loads.

import { type ChildProcess, spawn } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type BuildOptions, build, context, type Plugin } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");
const STATIC_FILES = ["index.html", "styles.css"];

const flags = new Set(process.argv.slice(2));
const watch = flags.has("--watch");
const serve = flags.has("--serve");

async function copyStatic(): Promise<void> {
  await mkdir(DIST, { recursive: true });
  await Promise.all(STATIC_FILES.map((name) => copyFile(join(SRC, name), join(DIST, name))));
}

// In watch mode the static files are copied again after every rebuild, so an edit to the markup or
// the stylesheet lands on the next reload like an edit to the code does.
function afterEachBuild(onFirst: () => void): Plugin {
  let first = true;
  return {
    name: "x402-lab-static",
    setup(pluginBuild) {
      pluginBuild.onEnd(async (result) => {
        if (result.errors.length) {
          console.error(`build failed with ${result.errors.length} error(s)`);
          return;
        }
        await copyStatic();
        console.log(`built dist/ at ${new Date().toLocaleTimeString()}`);
        if (first) {
          first = false;
          onFirst();
        }
      });
    },
  };
}

const options: BuildOptions = {
  absWorkingDir: ROOT,
  entryPoints: [join(SRC, "app.ts")],
  outfile: join(DIST, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
  sourcemap: "linked",
  minify: !watch,
  legalComments: "none",
  logLevel: "warning",
};

let server: ChildProcess | null = null;

function startServer(): void {
  server = spawn(process.execPath, [join(ROOT, "server.ts")], { cwd: ROOT, stdio: "inherit", env: process.env });
  server.on("exit", (code) => {
    // The server refusing to start (a non-loopback host, a port in use) ends the session: a watcher
    // rebuilding a page nobody can load is not useful.
    if (code !== null && code !== 0) {
      console.error(`the server exited with ${code}`);
      process.exit(code);
    }
  });
}

function stop(): void {
  server?.kill();
  process.exit(0);
}

await rm(DIST, { recursive: true, force: true });

if (watch) {
  const ctx = await context({ ...options, plugins: [afterEachBuild(() => serve && startServer())] });
  await ctx.watch();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  try {
    await build(options);
  } catch {
    // esbuild has already printed each error with its location.
    process.exit(1);
  }
  await copyStatic();
  console.log("built dist/");
  if (serve) {
    startServer();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
}
