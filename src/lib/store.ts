// What survives a reload, and what deliberately does not.
//
// Guards (the spend ceiling and the pinned recipient) are kept PER TARGET: a ceiling that followed
// you from a test server to production would be the wrong ceiling at the worst moment, and a
// recipient pinned for one server has nothing to say about another.
//
// Agent tokens are kept because losing one on refresh is how you pay a second time for a balance
// you already hold. Runs are kept so a payment that went wrong can be exported and read later.
// Nothing here ever holds a private key: there is none in this process to hold.

import type { CheckRow } from "./checks.ts";
import { isRecord } from "./json.ts";
import type { Guards } from "./types.ts";

const PREFIX = "x402-lab";
const MAX_RUNS = 50;
const DEFAULT_GUARDS: Guards = { maxSpend: "1.00", expectedPayTo: "" };

/** One request in a run, as the run log and the export show it. */
export interface RunEntry {
  method: string;
  url: string;
  status: number | string;
  ms?: number | undefined;
  note?: string | undefined;
  request?: unknown;
  response?: unknown;
  headers?: Record<string, string> | undefined;
  at: string;
}

export interface Run {
  id: string;
  target: string;
  startedAt: string;
  entries: RunEntry[];
  checks: CheckRow[];
}

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(`${PREFIX}:${key}`);
    return raw === null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    // A private window, or storage turned off: in-memory is enough.
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(`${PREFIX}:${key}`, JSON.stringify(value));
  } catch {
    // Storage is a convenience here, never a requirement.
  }
}

export function loadGuards(targetKey: string): Guards {
  const stored = read(`guards:${targetKey}`);
  if (!isRecord(stored)) return { ...DEFAULT_GUARDS };
  return {
    maxSpend: typeof stored.maxSpend === "string" ? stored.maxSpend : DEFAULT_GUARDS.maxSpend,
    expectedPayTo: typeof stored.expectedPayTo === "string" ? stored.expectedPayTo : "",
  };
}

export function saveGuards(targetKey: string, guards: Guards): void {
  write(`guards:${targetKey}`, guards);
}

export function loadToken(targetKey: string): string | null {
  const stored = read(`token:${targetKey}`);
  return typeof stored === "string" && stored !== "" ? stored : null;
}

export function saveToken(targetKey: string, token: string): void {
  write(`token:${targetKey}`, token);
}

export function forgetToken(targetKey: string): void {
  try {
    localStorage.removeItem(`${PREFIX}:token:${targetKey}`);
  } catch {
    // Nothing stored means nothing to forget.
  }
}

/**
 * The expiry of a JWT, read without verifying it. Showing it is the point: an expired token is
 * answered with a 402, and knowing that in advance beats being surprised by one.
 */
export function tokenExpiry(token: string | null | undefined): Date | null {
  try {
    const segment = (token ?? "").split(".")[1];
    if (!segment) return null;
    const claims: unknown = JSON.parse(atob(segment.replace(/-/g, "+").replace(/_/g, "/")));
    return isRecord(claims) && typeof claims.exp === "number" ? new Date(claims.exp * 1000) : null;
  } catch {
    return null;
  }
}

export function loadRuns(): Run[] {
  const stored = read("runs");
  return Array.isArray(stored) ? (stored.filter(isRecord) as unknown as Run[]) : [];
}

export function saveRun(run: Run): void {
  const runs = loadRuns();
  const at = runs.findIndex((r) => r.id === run.id);
  if (at >= 0) runs[at] = run;
  else runs.unshift(run);
  write("runs", runs.slice(0, MAX_RUNS));
}

export function clearRuns(): void {
  write("runs", []);
}

/**
 * One run as something that can be pasted into an issue: every request, its status, and the
 * decoded payment documents. A bug report about a payment that says "it failed" is unactionable;
 * this is the same event with the wire in it.
 */
export function runToMarkdown(run: Run): string {
  const fence = "```";
  const lines = [`### x402 run ${run.id}`, "", `target: ${run.target}`, `started: ${run.startedAt}`, ""];
  for (const entry of run.entries ?? []) {
    lines.push(`**${entry.method} ${entry.url}** -> ${entry.status}${entry.ms ? ` (${entry.ms} ms)` : ""}`);
    if (entry.note) lines.push(`: ${entry.note}`);
    if (entry.request) lines.push(`${fence}json\n${trim(entry.request)}\n${fence}`);
    if (entry.response) lines.push(`${fence}json\n${trim(entry.response)}\n${fence}`);
    lines.push("");
  }
  if (run.checks?.length) {
    lines.push("Pre-flight:");
    for (const row of run.checks) lines.push(`- ${row.state}: ${row.label} ${row.value} (${row.why})`);
  }
  return lines.join("\n");
}

function trim(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 4000 ? `${text.slice(0, 4000)}\n... truncated` : text;
}
