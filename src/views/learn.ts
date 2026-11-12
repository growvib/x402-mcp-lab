// Learn: the protocol in the order you meet it.
//
// Written for somebody who has just watched a payment happen in the playground and wants to know
// what they saw. It states the mechanism, not the marketing, and every section corresponds to
// something the playground actually shows, so the two can be read side by side.

import { app } from "../app.ts";
import { el } from "../lib/ui.ts";

interface Beat {
  title: string;
  body: string;
  detail: string;
}

type OutcomeKind = "ok" | "warn" | "bad" | "";

const BEATS: readonly Beat[] = [
  {
    title: "You ask for something without paying",
    body: "A normal request to a paid endpoint. No wallet is involved, nothing is signed, and nothing is charged for asking.",
    detail: "Any HTTP method the resource accepts. Over MCP it is an ordinary tool call with no payment argument.",
  },
  {
    title: "The server answers with its price",
    body: "HTTP 402 Payment Required, carrying what to pay, to whom, on which network, in which token, and how long the offer stands.",
    detail:
      "The same document arrives twice: as JSON in the body and base64 in the PAYMENT-REQUIRED header. MCP has no 402, so a paid tool returns the identical shape inside its result.",
  },
  {
    title: "Your wallet signs an authorization",
    body: "Not a transfer. A signed permission to move an exact amount to an exact address, which expires. Your key never leaves your wallet, and this lab never sees it.",
    detail:
      "EIP-3009 transferWithAuthorization, signed as EIP-712 typed data under the token's own domain. The lab simulates the settlement before sending it, so a signature the token would refuse is caught here.",
  },
  {
    title: "The same request again, now carrying the payment",
    body: "A facilitator checks the authorization, submits the transfer, and the server does the work it was asked for.",
    detail:
      "The payload travels in PAYMENT-SIGNATURE, or as the `payment` argument over MCP. The settlement result comes back in PAYMENT-RESPONSE.",
  },
];

const OUTCOMES: ReadonlyArray<readonly [title: string, kind: OutcomeKind, body: string]> = [
  ["Delivered", "ok", "Money moved and you got what you asked for."],
  [
    "Paid, nothing created",
    "warn",
    "Money moved and the server made nothing. The funds sit as a balance on that endpoint. Paying again buys nothing: spend the balance.",
  ],
  [
    "Not confirmed",
    "warn",
    "The settlement has no answer yet. It may still land, so nothing may send that payment again.",
  ],
  [
    "Refused before payment",
    "",
    "The server said no before any money moved, usually a duplicate or an invalid request.",
  ],
  ["Payment rejected", "bad", "The authorization was not accepted. Nothing left your wallet."],
];

const CHECKS: ReadonlyArray<readonly [name: string, why: string]> = [
  [
    "The recipient",
    "The one mistake with no way back. Pin the address you expect and a quote naming anyone else is refused.",
  ],
  [
    "The amount",
    "Compared in the token's smallest units against your limit, never as a decimal. A wrong power of ten is a thousandfold error.",
  ],
  ["The token", "The contract is asked its own name and symbol. Anyone can deploy a token called USDC."],
  [
    "The signing domain",
    "Hashed and compared against what the token itself reports. Sign under the wrong one and you get a valid signature the token refuses, with nothing in the error to say why.",
  ],
  ["The settlement", "Simulated against the token with your real signature before anything is sent."],
];

const SAFEGUARDS: ReadonlyArray<readonly [name: string, why: string]> = [
  [
    "Your key stays in your wallet",
    "The lab has no key, no seed phrase and no way to sign on your behalf. It asks your wallet, and your wallet asks you.",
  ],
  [
    "It runs on your machine only",
    "The local server answers on loopback, refuses any request that did not come from this page, and forwards only to endpoints you allowed.",
  ],
  [
    "It never retries a payment",
    "No automatic retry anywhere. A repeated payment is a repeated charge, so repeating is always your decision.",
  ],
  [
    "It paces you",
    "One payment at a time, a few seconds between them, and a cap per session. A stuck loop cannot drain a wallet.",
  ],
  [
    "Exports are redacted",
    "The token that spends your balance is stripped from anything you copy out, so a run pasted into an issue cannot be spent by whoever reads it.",
  ],
];

export function renderLearn(): HTMLElement {
  return el(
    "div",
    { class: "page" },
    el(
      "div",
      {},
      el("div", { class: "eyebrow" }, "Learn"),
      el("h1", {}, "How one payment works."),
      el(
        "p",
        { class: "lede" },
        "Four exchanges, no account, no invoice. The playground shows each one as it happens; this is what you are looking at.",
      ),
    ),

    el(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "12px" } },
      ...BEATS.map((beat, index) =>
        el(
          "div",
          { class: "card" },
          el(
            "div",
            { class: "card-body" },
            el(
              "div",
              { style: { display: "flex", gap: "14px" } },
              el(
                "div",
                {
                  class: "step-dot",
                  style: { background: "var(--accent)", borderColor: "var(--accent)", color: "var(--accent-ink)" },
                },
                String(index + 1),
              ),
              el(
                "div",
                { style: { flex: "1" } },
                el("h2", {}, beat.title),
                el("p", { class: "lede", style: { marginTop: "6px", fontSize: "14px" } }, beat.body),
                app.mode === "advanced"
                  ? el("p", { class: "help", style: { marginTop: "8px" } }, beat.detail)
                  : el(
                      "details",
                      { style: { marginTop: "8px" } },
                      el("summary", { class: "help" }, "Protocol detail"),
                      el("p", { class: "help", style: { marginTop: "8px" } }, beat.detail),
                    ),
              ),
            ),
          ),
        ),
      ),
    ),

    el(
      "div",
      { class: "card" },
      el("div", { class: "card-head" }, el("h3", {}, "What can come back")),
      el(
        "div",
        { class: "card-body" },
        el(
          "p",
          { class: "help" },
          "Payment and delivery are separate outcomes, and the interesting cases are the ones where they disagree.",
        ),
        el(
          "div",
          { class: "status-rows" },
          ...OUTCOMES.map(([title, kind, body]) =>
            el(
              "div",
              { class: "status-row" },
              el(
                "div",
                { class: `status-icon ${kind || "idle"}` },
                kind === "ok" ? "✓" : kind === "bad" ? "✗" : kind === "warn" ? "!" : "·",
              ),
              el("div", {}, el("div", { class: "status-text" }, title), el("div", { class: "status-note" }, body)),
            ),
          ),
        ),
      ),
    ),

    el(
      "div",
      { class: "card" },
      el("div", { class: "card-head" }, el("h3", {}, "What the checks are for")),
      el(
        "div",
        { class: "card-body" },
        el(
          "p",
          { class: "help" },
          "Before your wallet opens, the lab compares the quote against what it can independently verify. Each check exists because getting it wrong costs money in a way that cannot be undone.",
        ),
        explainTable(CHECKS, "180px"),
      ),
    ),

    el(
      "div",
      { class: "card" },
      el("div", { class: "card-head" }, el("h3", {}, "How this lab keeps you safe")),
      el("div", { class: "card-body" }, explainTable(SAFEGUARDS, "220px")),
    ),
  );
}

function explainTable(rows: ReadonlyArray<readonly [name: string, why: string]>, width: string): HTMLTableElement {
  return el(
    "table",
    {},
    ...rows.map(([name, why]) =>
      el("tr", {}, el("td", { style: { width, fontWeight: "500" } }, name), el("td", { class: "muted" }, why)),
    ),
  );
}
