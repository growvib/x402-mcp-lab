// The playground: choose, request, review the payment, see what happened.
//
// One flow for both transports. HTTP and MCP differ in how the payment requirements travel (a 402
// header, or a field in a tool result) and in nothing else that matters to the person paying, so
// they share the steps, the checks, the signer and the outcome. Where they genuinely differ, the
// step says so.
//
// This file is the shell and nothing else: which steps exist, which one is open, what a finished
// one collapses to. Each step lives in playground/ beside its own actions, so the review step and
// the catalog step cannot reach into each other without an import saying so.
//
//   state.ts    where the run is, and what is in the request body
//   facts.ts    what the checks are checked against
//   format.ts   how a value is written down, in one place
//   catalog.ts  choose what to buy, and which setup of it
//   request.ts  the request, and the handshake it starts
//   payment.ts  the quote, the checks, the rails, the signature
//   result.ts   what happened, as two separate facts
//   mcp.ts      the same flow with the requirements in a tool result
//
// Two rules shape the layout:
//
//   1. A finished step collapses to one line you can reopen. The screen is always about the
//      decision in front of you, and the amount is never more than one glance away.
//   2. Passing checks are a count. Failing checks are the page.

import { app, currentTarget, type Mode, render, setMode, startRun } from "../app.ts";
import { el } from "../lib/ui.ts";
import { requirementAmount } from "../lib/x402.ts";
import { stepChoose } from "./playground/catalog.ts";
import { money, networkName, summaryRow } from "./playground/format.ts";
import { chooseToolCard } from "./playground/mcp.ts";
import { stepReview } from "./playground/payment.ts";
import { stepRequest } from "./playground/request.ts";
import { footer, inspector, stepResult } from "./playground/result.ts";
import { clearPayment, currentStep, goTo, type StepId, state, steps, type Transport } from "./playground/state.ts";

export function renderPlayground(): HTMLElement {
  const s = state();
  const step = currentStep();
  const list = steps();
  const position = list.findIndex((entry) => entry.id === step);

  return el(
    "div",
    { class: `page ${app.mode === "advanced" ? "wide" : ""}` },
    header(step),
    transportTabs(),
    el(
      "div",
      { class: "steps" },
      ...list.flatMap((entry, index) => [
        index ? el("div", { class: "step-line" }) : null,
        el(
          "div",
          { class: `step ${index < position ? "done" : index === position ? "on" : ""}` },
          el("div", { class: "step-dot" }, index < position ? "✓" : String(index + 1)),
          el("span", {}, entry.label),
        ),
      ]),
    ),

    s.error ? el("div", { class: "callout bad" }, el("div", { class: "callout-body" }, s.error)) : null,

    ...list.map((entry, index) => {
      if (index > position) return null;
      if (index < position) return summaryFor(entry.id);
      return stepBody(entry.id);
    }),

    inspector(),
    footer(),
  );
}

function header(step: StepId): HTMLElement {
  const mcp = state().transport === "mcp";
  const titles: Record<StepId, string> = {
    choose: mcp ? "Pick a tool to call." : "Pick what to buy.",
    request: mcp ? "Fill in the arguments." : "Build the request.",
    review: "See a payment happen.",
    result: "What happened.",
  };
  const ledes: Record<StepId, string> = {
    choose: mcp
      ? "The server lists what it can do. Tools that cost money are marked."
      : "The catalog comes from the endpoint itself. Your choice fills the request.",
    request: "Nothing is sent yet, and nothing is charged for asking.",
    review: "One request, a payment quote, and a resource unlocked.",
    result: "Payment and delivery are two separate outcomes, so they are two separate statuses.",
  };

  return el(
    "div",
    {},
    el("div", { class: "eyebrow" }, `Playground / ${mcp ? "MCP" : "HTTP"}`),
    el(
      "div",
      { style: { display: "flex", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" } },
      el(
        "div",
        { style: { flex: "1", minWidth: "260px" } },
        el("h1", {}, titles[step]),
        el("p", { class: "lede" }, ledes[step]),
      ),
      modeToggle(),
    ),
  );
}

const MODES: ReadonlyArray<readonly [Mode, string]> = [
  ["guided", "Guided"],
  ["advanced", "Advanced"],
];

function modeToggle(): HTMLElement {
  return el(
    "div",
    { class: "segmented", style: { marginTop: "10px" } },
    ...MODES.map(([mode, label]) =>
      el("button", { class: app.mode === mode ? "on" : "", onClick: () => setMode(mode) }, label),
    ),
  );
}

function transportTabs(): HTMLElement {
  const s = state();
  const pick = (transport: Transport) => {
    if (s.transport === transport) return;
    s.transport = transport;
    s.step = null;
    clearPayment(s);
    s.toolResult = null;
    startRun();
    render();
  };
  return el(
    "div",
    { class: "tabs" },
    el("div", { class: `tab ${s.transport === "http" ? "on" : ""}`, onClick: () => pick("http") }, "HTTP request"),
    el("div", { class: `tab ${s.transport === "mcp" ? "on" : ""}`, onClick: () => pick("mcp") }, "MCP tool call"),
  );
}

// ---------------------------------------------------------------------------
// Finished steps, as one line each

function summaryFor(step: StepId): HTMLElement | null {
  const s = state();
  const reopen = () => goTo(step);
  if (step === "choose") {
    if (s.transport === "mcp") return summaryRow(s.tool?.name ?? "tool", "MCP tool", "Change", reopen);
    const chosen = [s.choice.service?.title, s.choice.option?.label].filter(Boolean).join(" · ");
    return chosen
      ? summaryRow(chosen, "From the endpoint's catalog", "Change", reopen)
      : summaryRow("Nothing chosen", "The request below is being written by hand", "Open the catalog", reopen);
  }
  if (step === "request") {
    const target = currentTarget();
    const label =
      s.transport === "mcp"
        ? `${s.tool?.name ?? "tool"} · ${Object.keys(s.toolForm?.read() ?? {}).length} arguments`
        : `${target.method} ${target.resource}`;
    return summaryRow(label, target.name, "Edit request", reopen, { mono: true });
  }
  if (step === "review") {
    const { value: amount } = requirementAmount(s.requirement);
    return summaryRow(
      money(amount),
      networkName(s.requirement?.network),
      "View checks",
      () => {
        s.checksOpen = true;
        goTo("review");
      },
      { mono: true },
    );
  }
  return null;
}

function stepBody(step: StepId): HTMLElement {
  // The Choose step is the one place the two transports genuinely differ: a catalog of things to
  // buy, or a list of tools to call. Both fill the same request and everything after this is
  // shared, so the fork lives here rather than inside either of them.
  if (step === "choose") return state().transport === "mcp" ? chooseToolCard() : stepChoose();
  if (step === "request") return stepRequest();
  if (step === "review") return stepReview();
  return stepResult();
}
