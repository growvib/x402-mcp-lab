// Orders: what the paying wallet bought, read back from the endpoint.
//
// An order response is a snapshot of the moment it was placed, and it says PENDING every time. Whether
// the order then ran, and what it was actually placed as, is a second question the endpoint answers
// on its order read. The option in particular: a "High Quality" order that the endpoint recorded as
// "Standard" read as a success on the result screen, because nothing on it asked the endpoint what
// it had placed. Both reads here are GETs with no payment attached, so nothing on this page can buy
// anything.
//
// The token is the agent token the last payment or sign-in returned, so the list is the orders of
// the wallet that token belongs to: a Solana payment and an EVM sign-in are two different accounts.

import { app, currentTarget, defineViewState, http, render, signInState, signInWithWallet } from "../app.ts";
import { type Delivery, listOrders, type Order, type OrdersApi, ordersOf, readOrder } from "../lib/agent.ts";
import { stringOf } from "../lib/json.ts";
import { busyLabel, el, relativeTime } from "../lib/ui.ts";
import { metric } from "./playground/format.ts";

const PAGE_SIZE = 10;

interface OrdersState {
  page: number;
  /** The rows of the current page. Null until the first read answers. */
  rows: Order[] | null;
  total: number;
  busy: boolean;
  error: string | null;
  /** The source and token the automatic first read ran for. */
  loadedFor: string | null;
  /** The order whose detail is open. */
  open: string | null;
  /** The order being read again. */
  reading: string | null;
  readError: string | null;
}

const state = defineViewState<OrdersState>("orders", () => ({
  page: 1,
  rows: null,
  total: 0,
  busy: false,
  error: null,
  loadedFor: null,
  open: null,
  reading: null,
  readError: null,
}));

export function renderOrders(): HTMLElement {
  const s = state();
  const orders = ordersOf(app.target);

  // One automatic read per token and source, the first time the page is opened with both. Deferred
  // so it runs after this render rather than inside it.
  const key = `${app.target?.id}:${app.agentToken || ""}`;
  if (orders?.list && app.agentToken && s.loadedFor !== key && !s.busy) {
    s.loadedFor = key;
    queueMicrotask(() => void loadPage(s.page));
  }

  return el(
    "div",
    { class: "page" },
    el(
      "div",
      { style: { display: "flex", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" } },
      el(
        "div",
        { style: { flex: "1", minWidth: "240px" } },
        el("div", { class: "eyebrow" }, "Orders"),
        el("h1", {}, "What this wallet bought."),
        el("p", { class: "lede" }, "Read from the endpoint with your agent token. Nothing on this page can pay."),
      ),
      orders?.list && app.agentToken
        ? el(
            "button",
            { id: "ordersRefresh", class: "sm", disabled: s.busy, onClick: () => void loadPage(s.page) },
            s.busy ? busyLabel("Refreshing...") : "Refresh",
          )
        : null,
    ),
    body(orders),
  );
}

function body(orders: OrdersApi | null): HTMLElement {
  const s = state();
  if (!orders?.list) {
    return el(
      "div",
      { class: "callout info" },
      el(
        "div",
        { class: "callout-body" },
        `${app.target?.name || "This source"} does not publish an order list, so there is nothing to read back here.`,
      ),
    );
  }
  if (!app.agentToken) {
    return el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "card-body" },
        el(
          "p",
          { class: "help" },
          "Orders are read with the agent token a payment returns. Pay once, or sign in with the wallet that paid: " +
            "the signature is a message, not a payment, and moves nothing.",
        ),
        signInState.error
          ? el("div", { class: "callout bad" }, el("div", { class: "callout-body" }, signInState.error))
          : null,
        el(
          "div",
          {},
          el(
            "button",
            {
              class: "primary",
              disabled: signInState.busy || !app.wallet,
              onClick: () => void signInWithWallet(),
            },
            signInState.busy ? busyLabel("Waiting for your wallet...") : "Sign in with this wallet",
          ),
          !app.wallet
            ? el("span", { class: "help", style: { marginLeft: "12px" } }, "Connect a wallet first, from the top bar.")
            : null,
        ),
      ),
    );
  }

  const rows = s.rows || [];
  const first = rows.length ? (s.page - 1) * PAGE_SIZE + 1 : 0;
  const last = (s.page - 1) * PAGE_SIZE + rows.length;
  const pages = Math.max(1, Math.ceil(s.total / PAGE_SIZE));

  return el(
    "div",
    { class: "stack" },
    s.error ? el("div", { class: "callout bad" }, el("div", { class: "callout-body" }, s.error)) : null,
    s.rows === null && s.busy
      ? el("div", { class: "help" }, "Reading your orders...")
      : s.rows !== null && rows.length === 0 && !s.error
        ? el(
            "div",
            { class: "callout info" },
            el(
              "div",
              { class: "callout-body" },
              "No orders for this wallet yet. Place one in the playground and it appears here.",
            ),
          )
        : null,
    rows.length
      ? el(
          "div",
          { class: "count-line" },
          el("span", {}, `Showing ${first}-${last} of ${s.total}`),
          el("span", { class: "muted" }, "newest first"),
        )
      : null,
    rows.length
      ? el(
          "div",
          { class: "pick-list", id: "ordersList" },
          ...rows.flatMap((order) => {
            const id = order.order_id ?? null;
            return [
              el(
                "button",
                {
                  class: `pick tall order-row ${id !== null && s.open === id ? "on" : ""}`,
                  "data-order-id": id,
                  onClick: () => {
                    s.open = s.open === id ? null : id;
                    s.readError = null;
                    render();
                  },
                },
                el(
                  "div",
                  { class: "pick-body" },
                  el("span", { class: "pick-title" }, orderTitle(order)),
                  el("span", { class: "pick-meta" }, orderMeta(order)),
                ),
                statusPill(order.status),
                el("span", { class: "pick-price" }, usd(order.charged_usd)),
              ),
              id !== null && s.open === id ? orderDetail(order, id) : null,
            ];
          }),
        )
      : null,
    s.total > PAGE_SIZE
      ? el(
          "div",
          { class: "pager" },
          el(
            "button",
            { class: "sm", disabled: s.busy || s.page <= 1, onClick: () => void loadPage(s.page - 1) },
            "Previous",
          ),
          el("span", { class: "help" }, `Page ${s.page} of ${pages}`),
          el(
            "button",
            { class: "sm", disabled: s.busy || s.page >= pages, onClick: () => void loadPage(s.page + 1) },
            "Next",
          ),
        )
      : null,
  );
}

function orderMeta(order: Order): string {
  const created = stringOf(order.created_at);
  return [
    order.tracking_code,
    order.quantity ? `${order.quantity} ${order.quantity === 1 ? "unit" : "units"}` : null,
    created ? relativeTime(created) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function orderDetail(order: Order, id: string): HTMLDivElement {
  const s = state();
  const link = safeLink(order.link);
  return el(
    "div",
    { class: "order-detail" },
    orderFacts(order),
    s.readError ? el("div", { class: "callout bad" }, el("div", { class: "callout-body" }, s.readError)) : null,
    el(
      "div",
      { class: "row" },
      el(
        "button",
        {
          class: "sm",
          disabled: s.reading === id,
          onClick: () => void refreshOne(id),
        },
        s.reading === id ? busyLabel("Refreshing...") : "Refresh this order",
      ),
      link ? el("a", { href: link, target: "_blank", rel: "noreferrer noopener", class: "help" }, link) : null,
    ),
  );
}

// The order's link is the endpoint's JSON, so it becomes an href only when it is plainly a web
// address: a `javascript:` URL in somebody's response must not be one click from running here.
function safeLink(value: unknown): string | null {
  const text = stringOf(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? text : null;
  } catch {
    return null;
  }
}

async function loadPage(page: number): Promise<void> {
  const s = state();
  s.busy = true;
  s.error = null;
  render();
  try {
    const result = await listOrders({
      http,
      target: currentTarget(),
      token: app.agentToken,
      page,
      pageSize: PAGE_SIZE,
    });
    if (result.error !== undefined) {
      s.error = result.error;
      return;
    }
    s.rows = result.orders;
    s.total = result.total;
    s.page = result.page;
  } finally {
    s.busy = false;
    render();
  }
}

async function refreshOne(id: string): Promise<void> {
  const s = state();
  s.reading = id;
  s.readError = null;
  render();
  try {
    const result = await readOrder({ http, target: currentTarget(), token: app.agentToken, id });
    if (result.error !== undefined) {
      s.readError = result.error;
      return;
    }
    const fresh = result.order;
    s.rows = (s.rows ?? []).map((row) => (row.order_id === id ? fresh : row));
  } finally {
    s.reading = null;
    render();
  }
}

// ---------------------------------------------------------------------------
// Shared with the result step, so the two cannot describe one order differently.

// orderFacts is the order as the endpoint reports it now: status, what it was placed as, how much
// of it has arrived, what it cost, and when that was last true.
export function orderFacts(order: Order): HTMLDivElement {
  const delivered = deliveredOf(order);
  return el(
    "div",
    { class: "metrics" },
    metric("Status", statusPill(order.status)),
    metric("Placed as", [order.service_name, order.option_label].filter(Boolean).join(" · ") || "-"),
    metric(
      "Delivered",
      delivered,
      order.remains !== undefined && order.remains !== null ? `${order.remains} remaining` : "",
    ),
    ...(order.delivery ? [metric("Delivery", deliveryValue(order.delivery), deliveryDetail(order))] : []),
    metric("Charged", usd(order.charged_usd)),
    metric("Tracking code", order.tracking_code || "-"),
    metric(
      "Updated",
      order.updated_at ? relativeTime(order.updated_at) : "-",
      order.updated_at ? new Date(order.updated_at).toLocaleString() : "",
    ),
  );
}

export function statusPill(status: unknown): HTMLSpanElement {
  return el("span", { class: `pill ${statusKind(status)}` }, humanStatus(status));
}

// The endpoint's delivery block says what is known and nothing more: whether delivery has started,
// whether a start is overdue against the window the option listed, and on a per-post subscription
// whether it is still waiting for the target's next post. Completion time is never estimated, by the
// endpoint's own rule, so nothing here pretends to one.
function deliveryValue(delivery: Delivery): HTMLSpanElement {
  if (delivery.start_overdue) return el("span", { class: "pill bad" }, "Start overdue");
  if (delivery.waiting_for_post) return el("span", { class: "pill accent" }, "Waiting for the next post");
  if (delivery.started) return el("span", { class: "pill ok" }, "Started");
  return el("span", { class: "pill" }, "Not started yet");
}

function deliveryDetail(order: Order): string {
  const delivery = order.delivery ?? {};
  const parts: string[] = [];
  if (delivery.listed_start) parts.push(`listed start ${delivery.listed_start}`);
  else if (delivery.start_within_minutes) parts.push(`start within ${delivery.start_within_minutes} min`);
  if (order.posts) parts.push(`${order.posts} post${order.posts === 1 ? "" : "s"} covered per order`);
  return parts.join(" · ");
}

const FAILED = new Set(["CANCELED", "CANCELLED", "REFUNDED", "FAILED", "ERROR"]);
const ACTIVE = new Set(["PENDING", "IN_PROGRESS", "PROCESSING", "QUEUED"]);

function statusKind(status: unknown): string {
  const value = String(status ?? "").toUpperCase();
  if (value === "COMPLETED") return "ok";
  if (value === "PARTIAL" || value.startsWith("PARTIALLY_")) return "warn";
  if (FAILED.has(value)) return "bad";
  if (ACTIVE.has(value)) return "accent";
  return "";
}

function humanStatus(status: unknown): string {
  const value = String(status || "unknown")
    .toLowerCase()
    .replaceAll("_", " ");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function orderTitle(order: Order): string {
  return [order.service_name, order.option_label].filter(Boolean).join(" · ") || order.order_id || "Order";
}

function deliveredOf(order: Order): string {
  const quantity = Number(order.quantity);
  const remains = Number(order.remains);
  if (!Number.isFinite(quantity)) return "-";
  if (order.remains === undefined || order.remains === null || !Number.isFinite(remains)) return `? of ${quantity}`;
  return `${Math.max(0, quantity - remains)} of ${quantity}`;
}

// The endpoint's figure as it sent it, not rounded: charges on this channel go to a hundredth of a
// cent ($0.0178), and a page that rounds them to $0.02 is a second opinion about money.
function usd(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number}` : "-";
}
