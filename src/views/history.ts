// History: what this browser did, in order, and what is safe to hand to somebody else.
//
// The export is redacted by default. A run that ends in a payment carries the token that spends
// the balance the payment created, and the most natural thing to do with a run is paste it into an
// issue. Redacting on the way out, and saying how much was removed, is the only version of this
// that is safe to be casual with.

import { app, defineViewState, render } from "../app.ts";
import { redact } from "../lib/redact.ts";
import { clearRuns, loadRuns, type Run, runToMarkdown } from "../lib/store.ts";
import { el } from "../lib/ui.ts";

interface HistoryState {
  /** The run being shown. Null shows the newest. */
  selected: string | null;
}

const state = defineViewState<HistoryState>("history", () => ({ selected: null }));

export function renderHistory(): HTMLElement {
  const s = state();
  const current = app.run ? [app.run] : [];
  const runs = [...current, ...loadRuns().filter((run) => run.id !== app.run?.id)].filter(
    (run) => run.entries.length > 0,
  );
  const selected = runs.find((run) => run.id === s.selected) ?? runs[0];

  return el(
    "div",
    { class: "page" },
    el(
      "div",
      { style: { display: "flex", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" } },
      el(
        "div",
        { style: { flex: "1", minWidth: "240px" } },
        el("div", { class: "eyebrow" }, "History"),
        el("h1", {}, "Every request, in order."),
        el("p", { class: "lede" }, "Kept in this browser only. Nothing is uploaded anywhere."),
      ),
      runs.length
        ? el(
            "button",
            {
              class: "sm",
              onClick: () => {
                clearRuns();
                render();
              },
            },
            "Clear history",
          )
        : null,
    ),

    runs.length === 0
      ? el(
          "div",
          { class: "callout info" },
          el(
            "div",
            { class: "callout-body" },
            "Nothing yet. Ask for a payment quote in the playground and it lands here.",
          ),
        )
      : null,

    runs.length > 1
      ? el(
          "div",
          { class: "option-list" },
          ...runs.slice(0, 8).map((run) =>
            el(
              "button",
              {
                class: `option ${selected?.id === run.id ? "on" : ""}`,
                onClick: () => {
                  s.selected = run.id;
                  render();
                },
              },
              el(
                "div",
                { class: "option-main" },
                el("div", { class: "option-title" }, outcomeOf(run)),
                el("div", { class: "option-sub mono" }, `${run.id} · ${new Date(run.startedAt).toLocaleString()}`),
              ),
              el("span", { class: "pill" }, `${run.entries.length} events`),
            ),
          ),
        )
      : null,

    selected ? runCard(selected) : null,
  );
}

// outcomeOf is what the list says about a run without opening it. "Four events" tells you nothing;
// whether money moved tells you which run you are looking for.
function outcomeOf(run: Run): string {
  const statuses = run.entries.map((entry) => Number(entry.status)).filter(Number.isFinite);
  if (statuses.includes(201)) return "Paid and delivered";
  if (statuses.includes(200) && run.entries.some((entry) => entry.note?.includes("Payment sent")))
    return "Paid, nothing created";
  if (statuses.includes(202)) return "Payment not confirmed";
  if (statuses.includes(409)) return "Refused before payment";
  if (statuses.includes(402)) return "Quoted, not paid";
  return "No payment";
}

function runCard(run: Run): HTMLDivElement {
  const markdown = runToMarkdown(run);
  const { text, removed } = redact(markdown);

  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card-head" },
      el("h3", {}, outcomeOf(run)),
      el("span", { class: "detail" }, `${run.id} · ${new Date(run.startedAt).toLocaleString()}`),
      el("div", { class: "grow" }),
      el("button", { class: "sm", onClick: () => void navigator.clipboard?.writeText(text) }, "Copy for an issue"),
      el("button", { class: "sm quiet", onClick: () => download(run.id, text) }, "Download"),
    ),
    el(
      "div",
      { class: "card-body" },
      removed
        ? el(
            "div",
            { class: "callout ok" },
            el(
              "div",
              { class: "callout-body" },
              el("b", {}, `${removed} credential${removed === 1 ? "" : "s"} removed. `),
              "The copy above is safe to paste in public. The balance token and the signed payload are stripped.",
            ),
          )
        : null,

      el(
        "div",
        { class: "check-list" },
        ...run.entries.map((entry) =>
          el(
            "div",
            { class: "check-row", style: { gridTemplateColumns: "84px 1fr" } },
            el("span", { class: `pill ${statusKind(entry.status)}` }, String(entry.status)),
            el(
              "div",
              {},
              el("div", { class: "mono", style: { fontSize: "13px" } }, `${entry.method} ${entry.url}`),
              entry.note ? el("div", { class: "why" }, entry.note) : null,
              app.mode === "advanced" && entry.response
                ? el(
                    "details",
                    { style: { marginTop: "8px" } },
                    el("summary", { class: "help" }, "response"),
                    el("pre", {}, redact(String(entry.response).slice(0, 4000)).text),
                  )
                : null,
            ),
          ),
        ),
      ),

      run.checks?.length
        ? el(
            "details",
            {},
            el("summary", { class: "help" }, `Payment checks at the moment of signing (${run.checks.length})`),
            el(
              "div",
              { class: "check-list", style: { marginTop: "10px" } },
              ...run.checks.map((row) =>
                el(
                  "div",
                  { class: "check-row", style: { gridTemplateColumns: "20px 150px 1fr" } },
                  el(
                    "div",
                    { class: `check-mark ${row.state}` },
                    row.state === "ok" ? "✓" : row.state === "fail" ? "✗" : "?",
                  ),
                  el("div", {}, row.label),
                  el("div", { class: "why" }, row.why),
                ),
              ),
            ),
          )
        : null,

      el(
        "details",
        {},
        el("summary", { class: "help" }, "The exported text"),
        el("pre", { style: { marginTop: "10px" } }, text),
      ),
    ),
  );
}

function statusKind(status: number | string): string {
  const code = Number(status);
  if (code === 402) return "accent";
  if (code >= 200 && code < 300) return "ok";
  if (code >= 400 || status === "transport error") return "bad";
  return "";
}

function download(id: string, text: string): void {
  const blob = new Blob([text], { type: "text/markdown" });
  const href = URL.createObjectURL(blob);
  const link = el("a", { href, download: `x402-run-${id}.md` });
  document.body.append(link);
  link.click();
  link.remove();
  // Released after the click has handed the blob to the download, not before.
  setTimeout(() => URL.revokeObjectURL(href), 0);
}
