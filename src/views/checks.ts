// Server checks: is this endpoint one an agent can actually pay?
//
// The report is written to be pasted into somebody else's issue tracker, so every finding names
// the consequence rather than the vendor, failures come first, and a check that could not run says
// so instead of being counted as a pass. A green badge over an unrun money check is how a broken
// payment path ships with a certificate.

import { app, currentTarget, defineViewState, http, render, url } from "../app.ts";
import {
  type Outcome,
  type Report,
  runSuite,
  type SuiteOptions,
  type SuiteTarget,
  toMarkdown,
} from "../lib/conformance.ts";
import { errorMessage } from "../lib/json.ts";
import { el } from "../lib/ui.ts";

type Toggle = "probe" | "facilitator";

interface ChecksState {
  running: boolean;
  report: Report | null;
  error: string | null;
  /** What the last run was pointed at, for the heading of the exported report. */
  target: SuiteTarget | null;
  /** Send the refusal probes. On by default: neither probe can move money. */
  probe: boolean;
  /** Look the resource up in the facilitator index. Off by default: it is a request to a third party. */
  facilitator: boolean;
}

const state = defineViewState<ChecksState>("checks", () => ({
  running: false,
  report: null,
  error: null,
  target: null,
  probe: true,
  facilitator: false,
}));

const ORDER: Record<Outcome, number> = { fail: 0, warn: 1, skip: 2, pass: 3 };

async function run(): Promise<void> {
  const s = state();
  const source = currentTarget();
  s.running = true;
  s.report = null;
  s.error = null;
  render();

  const target: SuiteTarget = {
    url: url(source.resource),
    method: source.method,
    body: source.sampleBody,
    ...(source.mcp ? { mcpEndpoint: url(source.mcp) } : {}),
  };
  const options: SuiteOptions = {
    probe: s.probe,
    ...(s.facilitator && source.facilitator ? { facilitator: source.facilitator } : {}),
  };
  s.target = target;
  try {
    s.report = await runSuite({ http: (request) => http({ ...request, note: "Server check" }), target, options });
  } catch (error) {
    s.error = errorMessage(error);
  } finally {
    s.running = false;
    render();
  }
}

export function renderChecks(): HTMLElement {
  const s = state();
  const report = s.report;

  return el(
    "div",
    { class: "page" },
    el(
      "div",
      { style: { display: "flex", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" } },
      el(
        "div",
        { style: { flex: "1", minWidth: "260px" } },
        el("div", { class: "eyebrow" }, "Server checks"),
        el("h1", {}, "Can an agent pay this endpoint?"),
        el(
          "p",
          { class: "lede" },
          "About twenty-five checks over the payment request, what a browser client needs, how the endpoint can be discovered, how it refuses bad input, and its MCP surface.",
        ),
      ),
      el(
        "button",
        { class: "primary lg", disabled: s.running, onClick: () => void run() },
        s.running ? "Running..." : "Run the checks",
      ),
    ),

    el(
      "div",
      { class: "callout info" },
      el(
        "div",
        { class: "callout-body" },
        el("b", {}, "Nothing here spends. "),
        "One probe sends a payment header carrying a signature nothing made, which cannot authorize a transfer. The two checks that need real money are listed and skipped.",
      ),
    ),

    s.error ? el("div", { class: "callout bad" }, el("div", { class: "callout-body" }, s.error)) : null,

    report ? summary(report) : null,
    ...(report ? groups(report) : []),
    report ? share(report, s.target) : null,

    el(
      "div",
      { class: "card" },
      el("div", { class: "card-head" }, el("h3", {}, "Options")),
      el(
        "div",
        { class: "card-body" },
        toggle(
          "probe",
          "Send the refusal probes",
          "A malformed payment header and an unsigned payload. Neither can move money, and both catch an endpoint that answers with a server error or, worse, delivers anyway.",
        ),
        toggle(
          "facilitator",
          "Look for this resource in the facilitator index",
          currentTarget().facilitator || "No index is configured for this source.",
        ),
      ),
    ),
  );
}

function summary(report: Report): HTMLDivElement {
  const { pass, fail, warn, skip } = report.counts;
  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card-body" },
      el(
        "div",
        { class: "metrics" },
        count(pass, "passed", pass ? "var(--ok)" : null),
        count(fail, "failed", fail ? "var(--bad)" : null),
        count(warn, "warnings", warn ? "var(--warn)" : null),
        count(skip, "skipped", null),
      ),
      el(
        "p",
        { class: "help" },
        skip
          ? "Skipped checks are not passes. They needed something this run did not have, and each one says what."
          : "Every check that could run, ran.",
      ),
    ),
  );
}

function count(value: number, label: string, color: string | null): HTMLDivElement {
  return el(
    "div",
    { class: "metric" },
    // A zero is never painted in an alarm colour: a red 0 reads as a problem at a glance, which is
    // the opposite of what it says.
    el(
      "div",
      { class: "mono", style: { fontSize: "30px", fontWeight: "600", color: value && color ? color : "var(--faint)" } },
      String(value),
    ),
    el("span", { class: "label", style: { marginTop: "2px" } }, label),
  );
}

function groups(report: Report): HTMLDivElement[] {
  const names: string[] = [];
  for (const entry of report.checks) if (!names.includes(entry.group)) names.push(entry.group);
  // A group holding a failure comes first. Reading order is what a report is for.
  names.sort((a, b) => worst(report, a) - worst(report, b));

  return names.map((group) => {
    const rows = report.checks.filter((entry) => entry.group === group).sort((a, b) => ORDER[a.state] - ORDER[b.state]);
    const failed = rows.filter((row) => row.state === "fail").length;
    const warned = rows.filter((row) => row.state === "warn").length;

    return el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "card-head" },
        el("h3", {}, group),
        el("div", { class: "grow" }),
        failed ? el("span", { class: "pill bad" }, `${failed} failed`) : null,
        warned ? el("span", { class: "pill warn" }, `${warned} to look at`) : null,
        !failed && !warned ? el("span", { class: "pill ok" }, "all clear") : null,
      ),
      el(
        "div",
        { class: "check-list", style: { padding: "4px 18px 14px" } },
        ...rows.map((entry) =>
          el(
            "div",
            {
              class: `check-row ${entry.state === "fail" ? "failed" : ""}`,
              style: { gridTemplateColumns: "20px 1fr" },
            },
            el(
              "div",
              { class: `check-mark ${entry.state === "pass" ? "ok" : entry.state === "fail" ? "fail" : "unchecked"}` },
              entry.state === "pass" ? "✓" : entry.state === "fail" ? "✗" : entry.state === "warn" ? "!" : "·",
            ),
            el(
              "div",
              {},
              el("div", {}, entry.title),
              entry.state === "pass" && app.mode === "guided"
                ? null
                : el("div", { class: "why", style: { marginTop: "2px" } }, entry.detail),
              app.mode === "advanced" ? el("div", { class: "detail", style: { marginTop: "3px" } }, entry.spec) : null,
            ),
          ),
        ),
      ),
    );
  });
}

function worst(report: Report, group: string): number {
  const states = report.checks.filter((entry) => entry.group === group).map((entry) => ORDER[entry.state]);
  return Math.min(...states);
}

function share(report: Report, target: SuiteTarget | null): HTMLDivElement {
  return el(
    "div",
    { class: "card" },
    el("div", { class: "card-head" }, el("h3", {}, "Share this report")),
    el(
      "div",
      { class: "card-body" },
      el(
        "p",
        { class: "help" },
        "Findings name the spec section or the concrete consequence, never a vendor, so whoever maintains the endpoint can act on it without running this tool.",
      ),
      el(
        "div",
        { style: { display: "flex", gap: "10px", flexWrap: "wrap" } },
        el(
          "button",
          { class: "sm", onClick: () => navigator.clipboard?.writeText(toMarkdown(report, target ?? undefined)) },
          "Copy as markdown",
        ),
        el(
          "button",
          { class: "sm", onClick: () => navigator.clipboard?.writeText(JSON.stringify(report, null, 2)) },
          "Copy as JSON",
        ),
      ),
    ),
  );
}

function toggle(key: Toggle, label: string, hint: string): HTMLDivElement {
  const s = state();
  const on = s[key];
  return el(
    "div",
    {},
    el(
      "button",
      {
        class: "sm",
        style: { width: "100%", justifyContent: "flex-start" },
        onClick: () => {
          s[key] = !on;
          render();
        },
      },
      el("span", { class: `pill ${on ? "ok" : ""}` }, on ? "on" : "off"),
      label,
    ),
    el("p", { class: "help", style: { marginTop: "6px" } }, hint),
  );
}
