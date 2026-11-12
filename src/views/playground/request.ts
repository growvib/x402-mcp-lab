// The request, and what pressing the button starts.
//
// The fields are built from the resource's own published schema where there is one, and from the
// body otherwise. Above them, until there is a quote on the screen to be about, is the handshake
// itself: four beats, and the two facts people get wrong (asking costs nothing, and the wallet is
// not needed until the signature).

import { app, currentTarget, render } from "../../app.ts";
import { environmentLabel, isSimulation } from "../../lib/guard.ts";
import { busyLabel, el } from "../../lib/ui.ts";
import { fail } from "./format.ts";
import { callTool } from "./mcp.ts";
import { getQuote } from "./payment.ts";
import { bodySchema, formFor, state } from "./state.ts";

const HANDSHAKE_KEY = "x402-lab:handshake";

const BEATS: ReadonlyArray<readonly [label: string, text: string]> = [
  ["Ask", "Your request goes out with no payment on it. Nothing is charged and no wallet is involved."],
  [
    "Price",
    "The endpoint answers 402 with what it costs, who is paid, on which network, and for how long the quote stands.",
  ],
  [
    "Sign",
    "You read that in plain words and sign an authorization in your wallet. A signature is not a transfer: this page never touches a chain.",
  ],
  [
    "Settle",
    "The request goes again carrying the signature. The answer says what was charged and what was created, as two separate facts.",
  ],
];

function handshakeDismissed(): boolean {
  try {
    return localStorage.getItem(HANDSHAKE_KEY) === "hidden";
  } catch {
    return false;
  }
}

function dismissHandshake(): void {
  try {
    localStorage.setItem(HANDSHAKE_KEY, "hidden");
  } catch {
    // A private window: the card comes back next time, which is harmless.
  }
  render();
}

// Shown while this run has produced nothing yet. Once there is a quote the screen has a real
// subject and the teaching is in the way.
function handshakeCard(): HTMLElement | null {
  const s = state();
  if (s.quote || s.result || s.toolResult || handshakeDismissed()) return null;
  const target = currentTarget();

  return el(
    "div",
    { class: "card teach" },
    el(
      "div",
      { class: "card-head" },
      el("h3", {}, "What pressing that button starts"),
      el("div", { class: "grow" }),
      el("button", { class: "sm quiet", onClick: dismissHandshake }, "Hide this"),
    ),
    el(
      "div",
      { class: "card-body" },
      el(
        "ol",
        { class: "beats" },
        ...BEATS.map(([label, text]) => el("li", {}, el("b", {}, label), el("span", {}, text))),
      ),
      el(
        "div",
        { class: "teach-foot" },
        el("span", { class: "pill" }, app.wallet ? "Wallet connected" : "No wallet needed yet"),
        el(
          "span",
          { class: "help" },
          app.wallet
            ? "Connected. You will still see the amount before anything is signed."
            : "A quote needs no wallet. Connect one when you reach the signature, or read the quote and stop there.",
        ),
      ),
      isSimulation(target)
        ? el(
            "div",
            { class: "teach-foot" },
            el("span", { class: "pill accent" }, environmentLabel(target).text),
            el("span", { class: "help" }, "This source has no chain behind it, so every button here is free to press."),
          )
        : null,
      target.notes
        ? el(
            "div",
            { class: "callout info" },
            el("div", { class: "callout-body" }, el("b", {}, `About ${target.name}. `), target.notes),
          )
        : null,
    ),
  );
}

function optionNotes(): HTMLElement[] {
  const option = state().choice.option;
  const notes: HTMLElement[] = [];
  if (option?.linkType) {
    const scope = option.linkType === "post" ? ", not the profile or channel" : ", not a single post inside it";
    notes.push(
      el(
        "p",
        { class: "help" },
        `This option is ordered on a ${option.linkType}: the link is the ${option.linkType}'s own link${scope}.`,
      ),
    );
  }
  if (option?.requiresPosts) {
    notes.push(
      el(
        "p",
        { class: "help" },
        "A per-post subscription: the quantity is the amount for EACH post, posts is how many of the target's next posts it covers, and the price is posts times that amount.",
      ),
    );
  }
  return notes;
}

export function stepRequest(): HTMLElement {
  const s = state();
  const target = currentTarget();
  const http = s.transport === "http";
  const form = http ? formFor() : s.toolForm;
  const schema = bodySchema();

  const card = el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card-head" },
      http
        ? el(
            "h3",
            {},
            el("span", { class: "pill mono" }, target.method),
            " ",
            el("span", { class: "mono" }, target.resource),
          )
        : el("h3", { class: "mono" }, s.tool?.name ?? "tool"),
      el("div", { class: "grow" }),
      http && schema
        ? el(
            "button",
            {
              class: "sm quiet",
              onClick: () => {
                try {
                  s.body = form?.read() ?? s.body;
                } catch {
                  // Not JSON yet: keep the body as it was rather than lose what was typed.
                }
                s.raw = !s.raw;
                s.form = null;
                render();
              },
            },
            s.raw ? "Use the form" : "Edit as JSON",
          )
        : null,
    ),
    el(
      "div",
      { class: "card-body" },
      http && schema && !s.raw
        ? el("p", { class: "help" }, "These fields come from the endpoint's own published schema.")
        : null,
      http ? optionNotes() : null,
      el("div", { class: "field-grid" }, ...(form?.fields ?? [])),
      form?.fields.length ? null : el("p", { class: "help" }, "This call takes no arguments."),
    ),
    el(
      "div",
      { class: "card-foot" },
      el(
        "button",
        {
          class: "primary",
          disabled: s.busy !== null,
          onClick: () => void (http ? getQuote() : callTool()).catch(fail),
        },
        s.busy ? busyLabel(s.busy) : http ? "Get payment quote" : "Call the tool",
      ),
      el("span", { class: "help" }, "This asks what a payment would cost. Nothing is charged."),
    ),
  );

  const teaching = handshakeCard();
  return teaching ? el("div", { class: "stack" }, teaching, card) : card;
}
