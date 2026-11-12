// What happened, as two separate facts.
//
// Payment and delivery are reported apart from each other, because the case where they disagree is
// the one worth knowing by heart: the money moved, nothing was created, the funds are a balance on
// that endpoint, and paying again buys nothing.

import { app, currentTarget, http, render } from "../../app.ts";
import { ordersOf, readOrder } from "../../lib/agent.ts";
import { environmentLabel } from "../../lib/guard.ts";
import { isRecord, type JsonRecord } from "../../lib/json.ts";
import { maskToken } from "../../lib/redact.ts";
import type { HttpResponse } from "../../lib/types.ts";
import { busyLabel, el, relativeTime } from "../../lib/ui.ts";
import { decodeBase64Json, requirementAmount } from "../../lib/x402.ts";
import { orderFacts } from "../orders.ts";
import {
  dotKind,
  fail,
  hint,
  metric,
  money,
  prettyKey,
  type StatusKind,
  safeJson,
  shortHash,
  shortUrl,
  statusRow,
} from "./format.ts";
import { send } from "./payment.ts";
import { state, steps } from "./state.ts";

/** A base64 JSON header decoded to an object, or null when it is absent or not one. */
function decodedHeader(res: HttpResponse | undefined, name: string): JsonRecord | null {
  const raw = res?.headers[name];
  if (!raw) return null;
  const decoded = decodeBase64Json(raw);
  return decoded.ok && isRecord(decoded.value) ? decoded.value : null;
}

function text(record: JsonRecord | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

/** What the endpoint said about discovery indexing, from the EXTENSION-RESPONSES header. */
function bazaarOutcome(res: HttpResponse | undefined): { rejected: boolean; reason: string } | null {
  const bazaar = decodedHeader(res, "extension-responses")?.bazaar;
  if (!isRecord(bazaar)) return null;
  return { rejected: bazaar.status === "rejected", reason: text(bazaar, "rejectedReason") };
}

export function stepResult(): HTMLElement {
  const s = state();
  if (!s.result) {
    return el("div", { class: "callout info" }, el("div", { class: "callout-body" }, "Nothing has been sent yet."));
  }

  const { what } = s.result;
  const res = "res" in s.result ? s.result.res : undefined;
  const mcp = "mcp" in s.result ? s.result.mcp : undefined;
  const structured = mcp && isRecord(mcp.structuredContent) ? mcp.structuredContent : mcp;
  const fromBody = res ? safeJson(res.body) : null;
  const parsed: JsonRecord = structured ?? (isRecord(fromBody) ? fromBody : {});
  const status = res?.status ?? (mcp?.isError ? 500 : 200);
  const settled = decodedHeader(res, "payment-response");
  const tx = text(settled, "transaction") || text(settled, "txHash");
  const bazaar = bazaarOutcome(res);
  const orderRef = text(parsed, "order_id");

  // Payment and delivery are separate outcomes. A 200 means money moved and nothing was created,
  // which is the single most important distinction on this screen and used to be a footnote.
  const paid = s.payload !== null;
  const paymentOk = paid && [200, 201, 202].includes(status);
  const deliveryOk = status === 201 || orderRef !== "";
  const pending = status === 202;
  // An order paid out of the balance the endpoint holds. Nothing was signed and nothing moved on
  // chain, so saying "payment settled" would be false and saying "no payment was needed" would be
  // worse: money was spent, just not on chain.
  const fromBalance = what === "balance";

  // The placing response is a snapshot of the moment the order was created. What it was placed as
  // and what happened next come from the order read, asked once on arrival and again on request.
  const orderId = deliveryOk ? orderRef : "";
  const readable = Boolean(orderId && ordersOf(app.target)?.get && app.agentToken);
  if (readable && s.live?.id !== orderId) {
    s.live = { id: orderId, order: null, error: null, busy: false, at: null };
    queueMicrotask(() => void refreshLive());
  }

  const headline =
    deliveryOk && fromBalance
      ? "Delivered, paid from your balance"
      : deliveryOk && paid
        ? "Paid and delivered"
        : deliveryOk
          ? "Delivered"
          : pending
            ? "Waiting on the network"
            : paymentOk
              ? "Paid, nothing delivered"
              : "Not delivered";

  const reference =
    [orderRef ? `Reference ${orderRef}` : null, text(parsed, "tracking_code") || null].filter(Boolean).join(" · ") ||
    "The resource was returned";

  return el(
    "div",
    { class: "stack" },
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "card-head" },
        el("h3", {}, headline),
        el("div", { class: "grow" }),
        el("span", { class: "pill mono" }, `HTTP ${status}`),
      ),
      el(
        "div",
        { class: "card-body" },
        el(
          "div",
          { class: "status-rows" },
          fromBalance ? balanceRow(parsed, deliveryOk) : paymentRow({ paid, paymentOk, pending, tx }),
          statusRow(
            deliveryOk ? "ok" : paymentOk ? "bad" : "idle",
            deliveryOk
              ? "Your request was fulfilled"
              : paymentOk
                ? "The endpoint created nothing"
                : "Nothing was created",
            deliveryOk
              ? reference
              : paymentOk
                ? "Your money is safe as a balance on this endpoint. Do not pay again: spend the balance instead."
                : "",
          ),
          bazaar
            ? statusRow(
                bazaar.rejected ? "warn" : "ok",
                bazaar.rejected ? "Not indexed for discovery" : "Listed for discovery",
                bazaar.reason || "Other agents can find this resource through the facilitator",
              )
            : null,
        ),

        readable ? liveOrder() : null,

        what === "replay" && s.firstOrderId
          ? el(
              "div",
              { class: `callout ${orderRef === s.firstOrderId ? "ok" : "bad"}` },
              el(
                "div",
                { class: "callout-body" },
                orderRef === s.firstOrderId
                  ? "Replayed the identical payment and got the same result back. Nothing settled twice."
                  : "The replay produced a DIFFERENT result. One signed payment was charged twice.",
              ),
            )
          : null,

        resultTabs(parsed, res, mcp),
      ),
      el(
        "div",
        { class: "card-foot" },
        readable
          ? el(
              "button",
              { id: "refreshStatusButton", class: "sm", disabled: s.live?.busy, onClick: () => void refreshLive() },
              s.live?.busy ? busyLabel("Refreshing...") : "Refresh status",
            )
          : null,
        paid
          ? el("button", { class: "sm", onClick: () => void send("replay").catch(fail) }, "Replay the same payment")
          : null,
        el(
          "button",
          {
            class: "sm",
            onClick: () => {
              s.step = steps()[0]?.id ?? null;
              render();
            },
          },
          "Start another",
        ),
        el("div", { class: "grow" }),
        app.agentToken ? el("span", { class: "help mono" }, `balance token ${maskToken(app.agentToken)}`) : null,
      ),
    ),
    app.mode === "guided" && paymentOk && !deliveryOk
      ? hint(
          "Money moved and nothing was created.",
          "This is the one outcome worth knowing by heart: the funds sit as a balance on the endpoint. Paying again buys nothing.",
        )
      : null,
  );
}

function balanceRow(parsed: JsonRecord, deliveryOk: boolean): HTMLElement {
  const charged = dollars(parsed.charged_usd);
  const left = dollars(parsed.balance_usd);
  const nothingMoved = "Nothing was signed and nothing moved on chain";
  return statusRow(
    deliveryOk ? "ok" : "bad",
    deliveryOk ? `Charged to your balance${charged ? ` · ${charged}` : ""}` : "Your balance was not charged",
    deliveryOk && left ? `${left} left on this endpoint` : nothingMoved,
  );
}

function paymentRow({
  paid,
  paymentOk,
  pending,
  tx,
}: {
  paid: boolean;
  paymentOk: boolean;
  pending: boolean;
  tx: string;
}): HTMLElement {
  const s = state();
  const kind: StatusKind = paid ? (pending ? "warn" : paymentOk ? "ok" : "bad") : "idle";
  const headline = !paid
    ? "No payment was needed"
    : pending
      ? "Payment sent, not confirmed"
      : paymentOk
        ? `Payment settled · ${money(requirementAmount(s.requirement).value)}`
        : "Payment refused";
  const note = pending
    ? "It may still go through, so nothing here will send it again. Check the transaction before retrying."
    : paymentOk
      ? tx
        ? `Transaction ${shortHash(tx)}`
        : "The facilitator reported a settlement"
      : "Nothing left your wallet";
  return statusRow(kind, headline, note);
}

/**
 * The order as the endpoint reports it now, beside the snapshot above it. It also checks the one
 * thing a buyer cannot see from the snapshot: whether the order was placed as the option they
 * chose. A "High Quality" choice placed as "Standard" read as a clean success here until this asked.
 */
function liveOrder(): HTMLElement {
  const s = state();
  const live = s.live;
  const chosen = s.transport === "mcp" ? "" : (s.choice.option?.label ?? "");
  const placed = live?.order?.option_label ?? "";
  const mismatch = chosen && placed && chosen.trim().toLowerCase() !== placed.trim().toLowerCase();

  return el(
    "div",
    { class: "live-order", id: "liveOrder" },
    el(
      "div",
      { class: "live-order-head" },
      el("h3", {}, "Order status now"),
      el("span", { class: "help" }, live?.at ? `read ${relativeTime(live.at)}` : live?.busy ? "reading..." : ""),
    ),
    live?.error ? el("div", { class: "callout bad" }, el("div", { class: "callout-body" }, live.error)) : null,
    mismatch
      ? el(
          "div",
          { class: "callout bad", id: "optionMismatch" },
          el(
            "div",
            { class: "callout-body" },
            el("b", {}, "Placed as a different option. "),
            `You chose ${chosen}, and the endpoint placed this order as ${placed}. The charge is the placed option's price, so check it before paying for another.`,
          ),
        )
      : null,
    live?.order ? orderFacts(live.order) : null,
  );
}

export async function refreshLive(): Promise<void> {
  const live = state().live;
  if (!live || live.busy) return;
  live.busy = true;
  live.error = null;
  render();
  try {
    const result = await readOrder({ http, target: app.target, token: app.agentToken, id: live.id });
    if (result.error !== undefined) {
      live.error = result.error;
      return;
    }
    live.order = result.order;
    live.at = new Date().toISOString();
  } finally {
    live.busy = false;
    render();
  }
}

function resultTabs(parsed: JsonRecord, res: HttpResponse | undefined, mcp: JsonRecord | undefined): HTMLElement {
  const s = state();
  const tab = s.resultTab;
  const set = (next: typeof tab) => {
    s.resultTab = next;
    render();
  };
  const raw = mcp ? JSON.stringify(mcp, null, 2) : res?.body || res?.transportError || "";
  return el(
    "div",
    {},
    el(
      "div",
      { class: "tabs", style: { marginBottom: "14px" } },
      el("div", { class: `tab ${tab === "summary" ? "on" : ""}`, onClick: () => set("summary") }, "Summary"),
      el("div", { class: `tab ${tab === "raw" ? "on" : ""}`, onClick: () => set("raw") }, "Raw response"),
    ),
    tab === "summary"
      ? el(
          "div",
          { class: "metrics" },
          ...Object.entries(parsed)
            // Credentials never reach the summary: it is the part of the screen people screenshot.
            .filter(([key, value]) => typeof value !== "object" && !/token|signature/i.test(key))
            .slice(0, 8)
            .map(([key, value]) => metric(prettyKey(key), String(value))),
        )
      : el("pre", {}, raw),
  );
}

// ---------------------------------------------------------------------------
// Chrome

export function inspector(): HTMLElement | null {
  const entries = app.run?.entries ?? [];
  if (!entries.length) return null;
  const advanced = app.mode === "advanced";

  return el(
    "details",
    { class: "inspector", open: advanced },
    el(
      "summary",
      {},
      el("span", { class: "mono" }, "{ }"),
      el("span", {}, "Request inspector"),
      el("div", { class: "grow" }),
      el("span", {}, `${entries.length} event${entries.length === 1 ? "" : "s"} · headers and payloads`),
    ),
    ...entries
      .slice(-20)
      .map((entry) =>
        el(
          "div",
          { class: "event" },
          el("div", { class: `event-dot ${dotKind(entry.status)}` }),
          el(
            "div",
            { style: { minWidth: "0" } },
            el("div", { class: "mono", style: { fontSize: "13px" } }, `${entry.method} ${shortUrl(entry.url)}`),
            entry.note ? el("div", { class: "help" }, entry.note) : null,
            advanced && entry.response
              ? el(
                  "details",
                  { style: { marginTop: "8px" } },
                  el("summary", { class: "help" }, "response"),
                  el("pre", {}, String(entry.response).slice(0, 4000)),
                )
              : null,
          ),
          el("div", { class: "detail" }, `${entry.status}${entry.ms ? ` · ${entry.ms}ms` : ""}`),
        ),
      ),
  );
}

export function footer(): HTMLElement {
  const target = currentTarget();
  const label = environmentLabel(target);
  return el(
    "div",
    { class: "footer-note" },
    el("span", {}, label.detail),
    el("div", { class: "grow" }),
    el("span", { class: "mono" }, target.origin),
  );
}

/**
 * A dollar figure as the endpoint reported it. Neither the charge nor the balance is computed here:
 * a balance this page worked out for itself would be a second opinion about money.
 */
function dollars(value: unknown): string {
  const number = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(number) ? `$${number}` : "";
}
