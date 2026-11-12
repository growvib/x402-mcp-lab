#!/usr/bin/env node
//
// The headless half of x402 Lab: the same conformance suite the page runs, in a terminal and in
// CI, with the same code and therefore the same answers.
//
// It sends no payment. The one probe that carries a payment header carries a signature nothing
// made, which cannot authorize a transfer, and the checks that need real money are reported as
// skipped rather than guessed at.
//
//   node bin/x402-lab.ts check https://api.example.com/v1/agent/orders
//   node bin/x402-lab.ts check http://127.0.0.1:4999/resource --mcp http://127.0.0.1:4999/mcp
//   node bin/x402-lab.ts check <url> --body '{"item":"widget","quantity":1}' --json
//   node bin/x402-lab.ts serve

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Outcome, runSuite, type SuiteOptions, type SuiteTarget, toMarkdown } from "../src/lib/conformance.ts";
import { errorMessage } from "../src/lib/json.ts";
import type { HttpRequest, HttpResponse } from "../src/lib/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 30_000;

// The node transport: a direct fetch, with the same envelope the page's proxy returns, so the
// suite cannot tell which one it is running under.
async function http({ method = "GET", url, path, headers = {}, body }: HttpRequest): Promise<HttpResponse> {
  const started = Date.now();
  const target = url ?? path;
  if (!target) return { status: 0, ms: 0, headers: {}, body: "", transportError: "no url to request" };

  const sent: Record<string, string> = { ...headers };
  let payload: string | undefined;
  if (body !== undefined && body !== null && method !== "GET" && method !== "HEAD") {
    payload = typeof body === "string" ? body : JSON.stringify(body);
    if (!Object.keys(sent).some((key) => key.toLowerCase() === "content-type"))
      sent["content-type"] = "application/json";
  }
  try {
    const res = await fetch(target, {
      method,
      headers: sent,
      ...(payload === undefined ? {} : { body: payload }),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    const out: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return { status: res.status, ms: Date.now() - started, headers: out, body: text };
  } catch (error) {
    return { status: 0, ms: Date.now() - started, headers: {}, body: "", transportError: errorMessage(error) };
  }
}

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      out.positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key.startsWith("no-")) {
      out.flags[key.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out.flags[key] = true;
    else {
      out.flags[key] = next;
      i++;
    }
  }
  return out;
}

function stringFlag(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: number, text: string): string => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const MARK: Record<Outcome, () => string> = {
  pass: () => paint(32, "ok   "),
  fail: () => paint(31, "FAIL "),
  warn: () => paint(33, "warn "),
  skip: () => paint(90, "skip "),
};

async function readBodyFlag(value: string | undefined): Promise<unknown> {
  if (value === undefined) return undefined;
  if (value.startsWith("@")) return JSON.parse(await readFile(value.slice(1), "utf8")) as unknown;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`--body is not JSON: ${errorMessage(error)}`);
  }
}

async function commandCheck(args: Args): Promise<void> {
  const url = args.positional[1];
  if (!url) throw new Error("usage: x402-lab check <url> [--mcp <url>] [--body <json>] [--method POST]");

  const mcpEndpoint = stringFlag(args, "mcp");
  const body = await readBodyFlag(stringFlag(args, "body"));
  const target: SuiteTarget = {
    url,
    method: (stringFlag(args, "method") ?? "POST").toUpperCase(),
    ...(body === undefined ? {} : { body }),
    ...(mcpEndpoint ? { mcpEndpoint } : {}),
  };
  const facilitator = stringFlag(args, "facilitator");
  const options: SuiteOptions = {
    probe: args.flags.probe !== false,
    ...(facilitator ? { facilitator } : {}),
  };

  const report = await runSuite({ http, target, options });

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ target, ...report }, null, 2)}\n`);
  } else if (args.flags.markdown) {
    process.stdout.write(`${toMarkdown(report, target)}\n`);
  } else {
    let group: string | null = null;
    for (const entry of report.checks) {
      if (entry.group !== group) {
        group = entry.group;
        process.stdout.write(`\n${paint(1, group)}\n`);
      }
      process.stdout.write(`  ${MARK[entry.state]()} ${entry.title}\n`);
      if (entry.state !== "pass") process.stdout.write(`        ${paint(90, entry.detail)}\n`);
    }
    const { pass, fail, warn, skip } = report.counts;
    process.stdout.write(
      `\n${pass} passed · ${fail} failed · ${warn} warnings · ${skip} skipped\n` +
        paint(90, "A skipped check is not a pass. The money checks need a funded wallet.\n"),
    );
  }

  // Warnings do not fail a run by default: most are "a browser client cannot use this", which is
  // real but not every resource's problem. --strict is for a project that has decided otherwise.
  const failed = report.counts.fail > 0 || (args.flags.strict === true && report.counts.warn > 0);
  process.exitCode = failed ? 1 : 0;
}

function commandServe(): void {
  const child = spawn(process.execPath, [join(HERE, "..", "server.ts")], { stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
}

const USAGE = [
  "x402 lab",
  "",
  "  check <url>   run the conformance suite against an x402 resource",
  "                --mcp <url>          also check an MCP endpoint",
  "                --body <json|@file>  the request body the resource expects",
  "                --method <verb>      default POST",
  "                --facilitator <url>  a discovery index to look for the resource in",
  "                --no-probe           skip the refusal probes (they send no valid payment)",
  "                --json | --markdown  machine or issue-ready output",
  "                --strict             warnings fail the run too",
  "  serve         host the page on http://localhost:4402 (run `npm run build` first)",
  "",
].join("\n");

const args = parseArgs(process.argv.slice(2));
const command = args.positional[0];

try {
  if (command === "check") await commandCheck(args);
  else if (command === "serve") commandServe();
  else {
    process.stdout.write(USAGE);
    // An unknown command is a mistake; asking for help (or nothing) is not.
    process.exitCode = command && command !== "help" ? 1 : 0;
  }
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
}
