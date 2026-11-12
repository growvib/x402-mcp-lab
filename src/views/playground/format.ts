// How a value is written down.
//
// Every one of these is here because the same value was being formatted two ways in two places,
// which on a payment screen is how a figure and the figure beside it stop agreeing. Money goes
// through money(), an address through shortAddress(), a network through networkName(), and a
// server's own words through serverMessage().

import { render } from "../../app.ts";
import { toChecksumAddress } from "../../lib/abi.ts";
import { errorMessage } from "../../lib/json.ts";
import type { HttpResponse } from "../../lib/types.ts";
import { type Child, el, svgEl } from "../../lib/ui.ts";
import { formatUsd, serverSays } from "../../lib/x402.ts";
import { state } from "./state.ts";

const NETWORK_NAMES: Readonly<Record<string, string>> = {
  "eip155:8453": "Base",
  "eip155:84532": "Base Sepolia",
  "eip155:1": "Ethereum",
  "eip155:137": "Polygon",
  "eip155:42161": "Arbitrum",
  "eip155:10": "Optimism",
  // CAIP-2 names a Solana cluster by the first 32 characters of its genesis hash, which is not
  // something to put on a button. These three are the clusters.
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "Solana Devnet",
  "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z": "Solana Testnet",
};

export type StatusKind = "ok" | "bad" | "warn" | "idle";

export function metric(label: string, value: Child, detail?: Child): HTMLDivElement {
  return el(
    "div",
    { class: "metric" },
    el("span", { class: "label" }, label),
    el("div", { class: "value" }, value ?? "-"),
    detail ? el("div", { class: "detail" }, detail) : null,
  );
}

const STATUS_MARKS: Record<StatusKind, string> = { ok: "✓", bad: "✗", warn: "!", idle: "·" };

export function statusRow(kind: StatusKind, text: Child, note?: Child): HTMLDivElement {
  return el(
    "div",
    { class: "status-row" },
    el("div", { class: `status-icon ${kind}` }, STATUS_MARKS[kind]),
    el("div", {}, el("div", { class: "status-text" }, text), note ? el("div", { class: "status-note" }, note) : null),
  );
}

export function money(amount: unknown): string {
  const s = state();
  if (!amount) return "?";
  // Never "USDC" as a fallback. On a rail with no chain read behind it that was a guess printed as
  // a fact, on a mint the endpoint chose, next to a figure scaled by a decimals count that was the
  // same guess. When the unit is not known the atomic figure is the honest thing to show, because
  // it is the only number here that is certainly true.
  const decimals = s.token.decimals;
  if (decimals === undefined || decimals === null) return `${String(amount)} atomic units`;
  const symbol = s.token.symbol || (s.requirement?.asset ? shortAddress(s.requirement.asset) : "units");
  return `${formatUsd(amount, decimals)} ${symbol}`;
}

export function networkName(network: string | null | undefined): string {
  if (!network) return "-";
  const known = NETWORK_NAMES[network];
  if (known) return known;
  // An id nobody has named yet still has to read as something. A chain this tool has never heard
  // of is one word plus a reference, not 46 characters of genesis hash on a button.
  const [namespace = "", reference = ""] = network.split(":");
  const family = namespace === "eip155" ? "Chain" : namespace === "solana" ? "Solana" : namespace;
  return reference.length > 12 ? `${family} ${reference.slice(0, 6)}…` : `${family} ${reference}`;
}

export function shortAddress(address: string | null | undefined): string {
  if (!address) return "-";
  const display = (/^0x[0-9a-fA-F]{40}$/.test(address) && toChecksumAddress(address)) || address;
  return display.length > 18 ? `${display.slice(0, 8)}…${display.slice(-6)}` : display;
}

export function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

export function shortUrl(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

export function prettyKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\busd\b/i, "USD")
    .replace(/^./, (c) => c.toUpperCase());
}

export function serverMessage(res: HttpResponse): string {
  if (res.transportError) return res.transportError;
  return serverSays(res.body) || res.body.slice(0, 200);
}

export function safeJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Puts a failure on the page. The catch handler for every action a button starts. */
export function fail(error: unknown): void {
  state().error = errorMessage(error);
  render();
}

export function hint(title: Child, body: Child): HTMLDivElement {
  return el(
    "div",
    { class: "callout info" },
    // Wrapped, because `el` styles HTML elements and the icon only needs to be held in place.
    el(
      "span",
      { style: { display: "flex", flex: "none", marginTop: "1px" } },
      svgEl(
        "svg",
        {
          width: "17",
          height: "17",
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": "1.7",
          "stroke-linecap": "round",
          "aria-hidden": "true",
        },
        svgEl("path", { d: "M9.5 18h5M10 21h4" }),
        svgEl("path", { d: "M12 3a6 6 0 0 0-3.5 10.9c.6.5.9 1.2.9 1.9v.2h5.2v-.2c0-.7.3-1.4.9-1.9A6 6 0 0 0 12 3z" }),
      ),
    ),
    el(
      "div",
      { class: "callout-body" },
      el("div", { style: { color: "var(--ink)", fontWeight: "500" } }, title),
      el("div", {}, body),
    ),
  );
}

/** A 402 is the protocol working, not a failure. Painting it red taught people to expect red. */
export function dotKind(status: number | string): string {
  const code = Number(status);
  if (code === 402) return "info";
  if (code >= 200 && code < 300) return "ok";
  if (code >= 400 || status === "transport error") return "bad";
  return "";
}

/**
 * One finished step, as one line you can reopen. Monospace is for a value somebody might copy. A
 * product name is prose and a method and path is not, so the row is told which it is holding
 * rather than setting everything in code type.
 */
export function summaryRow(
  main: Child,
  sub: Child,
  actionLabel: string,
  onClick: () => void,
  { mono = false }: { mono?: boolean } = {},
): HTMLDivElement {
  return el(
    "div",
    { class: "summary-row" },
    el(
      "div",
      { class: "summary-main" },
      el("span", { class: mono ? "mono" : "", style: { fontWeight: "500" } }, main),
      sub ? el("span", { class: "muted" }, sub) : null,
    ),
    el("div", { class: "grow" }),
    el("button", { class: "sm quiet", onClick }, actionLabel),
  );
}
