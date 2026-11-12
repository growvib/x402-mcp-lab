// The Source drawer: where the requests go.
//
// This used to live in the navigation rail, next to the links, which put "which endpoint am I
// about to pay" and "which page am I looking at" in the same list. They are not the same kind of
// thing. Endpoint settings belong to the request, so they open beside it and close again.
//
// Discovery lives here too, for the same reason: finding a resource and choosing a resource are
// one decision.

import {
  app,
  currentTarget,
  defineViewState,
  dropAgentToken,
  http,
  paintSource,
  setTarget,
  signInState,
  signInWithWallet,
  updateTarget,
} from "../app.ts";
import { walletAuthOf } from "../lib/agent.ts";
import { environmentLabel, isMainnet } from "../lib/guard.ts";
import { asRecord, errorMessage, isRecord, type JsonRecord, stringOf } from "../lib/json.ts";
import { maskToken } from "../lib/redact.ts";
import { el } from "../lib/ui.ts";

type DiscoveryKind = "well-known" | "facilitator" | "card" | "openapi";

/** A resource a discovery document lists, as the drawer offers it. */
interface Found {
  url: string;
  name: string;
  detail: string;
  /** An MCP endpoint rather than a paid HTTP resource. */
  mcp?: boolean;
}

interface SourceState {
  probing: DiscoveryKind | null;
  /** What the last probe listed. Null before any probe has answered. */
  found: Found[] | null;
  probeError: string | null;
}

const state = defineViewState<SourceState>("source", () => ({ probing: null, found: null, probeError: null }));

const SOURCES: ReadonlyArray<readonly [kind: DiscoveryKind, name: string, detail: string]> = [
  ["well-known", "This domain's manifest", "/.well-known/x402"],
  ["facilitator", "Facilitator index", "resources other people have paid for"],
  ["card", "MCP server card", "/.well-known/mcp/server-card.json"],
  ["openapi", "OpenAPI document", "/openapi.json"],
];

function discoveryUrl(kind: DiscoveryKind): string {
  const target = currentTarget();
  switch (kind) {
    case "well-known":
      return target.wellKnown || "/.well-known/x402";
    case "facilitator":
      return target.facilitator;
    case "card":
      return "/.well-known/mcp/server-card.json";
    case "openapi":
      return "/openapi.json";
  }
}

async function probe(kind: DiscoveryKind): Promise<void> {
  const s = state();
  s.probing = kind;
  s.found = null;
  s.probeError = null;
  paintSource();

  const target = discoveryUrl(kind);
  if (!target) {
    s.probing = null;
    s.probeError = "This source names no facilitator index.";
    paintSource();
    return;
  }

  const res = await http({
    method: "GET",
    url: target,
    headers: { accept: "application/json" },
    note: `Discovery: ${kind}`,
  });
  s.probing = null;
  if (res.transportError || res.status !== 200) {
    s.probeError = res.transportError || `${target} answered ${res.status}`;
    paintSource();
    return;
  }
  try {
    s.found = extract(kind, JSON.parse(res.body));
  } catch (error) {
    s.probeError = `Not JSON: ${errorMessage(error)}`;
  }
  paintSource();
}

// Each discovery document is somebody else's JSON in one of several shapes, so every field is read
// as unknown and a row without a usable address is dropped rather than offered.
function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function extract(kind: DiscoveryKind, parsed: unknown): Found[] {
  const doc = asRecord(parsed);
  if (kind === "facilitator") {
    const rows = records(doc.data ?? doc.resources ?? doc.items ?? parsed);
    return rows.slice(0, 20).flatMap((row) => {
      const address = stringOf(row.resource) ?? stringOf(row.url);
      if (!address) return [];
      const metadata = asRecord(row.metadata);
      return [
        {
          url: address,
          name: stringOf(metadata.serviceName) ?? stringOf(row.serviceName) ?? hostOf(address),
          detail: stringOf(metadata.description) ?? stringOf(row.description) ?? "",
        },
      ];
    });
  }
  if (kind === "well-known") {
    return records(doc.resources ?? asRecord(doc.x402).resources).flatMap((row) => {
      const address = stringOf(row.url) ?? stringOf(row.resource);
      if (!address) return [];
      return [
        {
          url: address,
          name: stringOf(row.name) ?? hostOf(address),
          detail: `${stringOf(row.method) ?? "POST"} ${pathOf(address)}`,
        },
      ];
    });
  }
  if (kind === "card") {
    const servers = records(doc.servers ?? doc.endpoints ?? (doc.name ? [doc] : []));
    return servers.map((row) => ({
      url: stringOf(row.url) ?? stringOf(row.endpoint) ?? "",
      name: stringOf(row.name) ?? "MCP server",
      detail: [stringOf(row.description), stringOf(row.transport)].filter(Boolean).join(" · "),
      mcp: true,
    }));
  }
  return Object.entries(asRecord(doc.paths))
    .filter(([, methods]) => JSON.stringify(methods).includes("402"))
    .map(([path, methods]) => {
      const [first] = Object.values(asRecord(methods));
      return { url: path, name: path, detail: stringOf(asRecord(first).summary) ?? "declares a 402 response" };
    });
}

function useResource(item: Found): void {
  const s = state();
  let parsed: URL;
  try {
    parsed = new URL(item.url, currentTarget().origin);
  } catch {
    s.probeError = `${item.url} is not a url this lab can resolve.`;
    paintSource();
    return;
  }
  // The proxy forwards to allowlisted origins only. Saying so here, before the first request
  // fails, is the difference between a configuration step and a bug report.
  if (!app.config.allowedOrigins.includes(parsed.origin)) {
    s.probeError = `${parsed.origin} is not on this lab's allowlist. Restart the server with X402_LAB_ALLOW=${parsed.origin} to let it talk to that host.`;
    paintSource();
    return;
  }
  if (item.mcp) {
    updateTarget({ mcp: parsed.pathname });
  } else {
    updateTarget({ origin: parsed.origin, resource: parsed.pathname });
  }
  paintSource();
}

function inputValue(event: Event): string {
  const field = event.target;
  return field instanceof HTMLInputElement || field instanceof HTMLSelectElement ? field.value.trim() : "";
}

export function renderSource(): HTMLElement {
  const s = state();
  const target = currentTarget();
  const label = environmentLabel(target);

  return el(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "22px" } },
    el(
      "div",
      {},
      el("label", { class: "label", for: "sourcePreset" }, "Saved source"),
      el(
        "select",
        {
          id: "sourcePreset",
          onChange: (event) => {
            const id = inputValue(event);
            const preset = app.config.presets.find((entry) => entry.id === id);
            if (preset) setTarget(preset);
            paintSource();
          },
        },
        ...app.config.presets.map((preset) =>
          el("option", { value: preset.id, selected: preset.id === target.id }, preset.name),
        ),
      ),
      el(
        "p",
        { class: "help", style: { marginTop: "8px" } },
        el("span", { class: `pill ${label.kind}` }, label.text),
        " ",
        label.detail,
      ),
    ),

    isMainnet(target)
      ? el(
          "div",
          { class: "callout bad" },
          el(
            "div",
            { class: "callout-body" },
            el("b", {}, "Payments against this source are real. "),
            "The lab will ask you to confirm before the first one, and refuses to pay faster than once every few seconds.",
          ),
        )
      : null,

    el(
      "div",
      { class: "field-grid" },
      el(
        "div",
        {},
        el("label", { class: "label", for: "sourceOrigin" }, "Origin"),
        el("input", {
          id: "sourceOrigin",
          class: "mono",
          value: target.origin,
          onChange: (event) => updateTarget({ origin: inputValue(event) }),
        }),
      ),
      el(
        "div",
        {},
        el("label", { class: "label", for: "sourceMethod" }, "Method"),
        el(
          "select",
          { id: "sourceMethod", onChange: (event) => updateTarget({ method: inputValue(event) }) },
          ...["POST", "GET"].map((method) => el("option", { selected: target.method === method }, method)),
        ),
      ),
      el(
        "div",
        {},
        el("label", { class: "label", for: "sourceResource" }, "Paid resource"),
        el("input", {
          id: "sourceResource",
          class: "mono",
          value: target.resource,
          onChange: (event) => updateTarget({ resource: inputValue(event) }),
        }),
      ),
      el(
        "div",
        {},
        el("label", { class: "label", for: "sourceMcp" }, "MCP endpoint"),
        el("input", {
          id: "sourceMcp",
          class: "mono",
          placeholder: "none",
          value: target.mcp,
          onChange: (event) => updateTarget({ mcp: inputValue(event) }),
        }),
      ),
    ),

    target.notes ? el("div", { class: "callout info" }, el("div", { class: "callout-body" }, target.notes)) : null,

    el(
      "div",
      {},
      el("h3", { style: { marginBottom: "10px" } }, "Find a resource"),
      el(
        "div",
        { class: "option-list" },
        ...SOURCES.map(([kind, name, detail]) =>
          el(
            "button",
            { class: "option", onClick: () => void probe(kind) },
            el(
              "div",
              { class: "option-main" },
              el("div", { class: "option-title" }, name),
              el("div", { class: "option-sub mono" }, detail),
            ),
            s.probing === kind ? el("span", { class: "pill" }, "reading") : null,
          ),
        ),
      ),
      s.probeError
        ? el("p", { class: "help", style: { marginTop: "10px", color: "var(--warn)" } }, s.probeError)
        : null,
      s.found?.length
        ? el(
            "div",
            { class: "option-list", style: { marginTop: "12px" } },
            ...s.found.map((item) =>
              el(
                "div",
                { class: "option", style: { cursor: "default" } },
                el(
                  "div",
                  { class: "option-main" },
                  el("div", { class: "option-title" }, item.name),
                  el("div", { class: "option-sub mono" }, item.url),
                ),
                el("button", { class: "sm", onClick: () => useResource(item) }, "Use"),
              ),
            ),
          )
        : s.found
          ? el("p", { class: "help", style: { marginTop: "10px" } }, "Nothing listed there yet.")
          : null,
    ),

    balanceSection(),

    el(
      "div",
      {},
      el("h3", { style: { marginBottom: "10px" } }, "What this lab may reach"),
      el(
        "div",
        { class: "inset" },
        ...app.config.allowedOrigins.map((origin) =>
          el("div", { class: "mono", style: { fontSize: "12.5px" } }, origin),
        ),
      ),
      el(
        "p",
        { class: "help", style: { marginTop: "8px" } },
        "The local proxy forwards to these origins and refuses everything else. It also answers only on loopback and only with the token this page was served with, so a page on the open internet cannot drive it.",
      ),
    ),
  );
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value || "?";
  }
}

function pathOf(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value || "";
  }
}

// ---------------------------------------------------------------------------
// The balance on this endpoint
//
// A resource with a minimum payment leaves the difference behind whenever an order costs less than
// the minimum, and that remainder is spendable. Spending it needs proof of which wallet is asking,
// which is either the token the last order returned or a signature over an ERC-4361 message. The
// signature costs nothing and touches no chain, so it is offered here rather than being something
// you only get by paying again.
// ---------------------------------------------------------------------------

function balanceSection(): HTMLDivElement | null {
  const auth = walletAuthOf(app.target);
  if (!auth && !app.agentToken) return null;

  return el(
    "div",
    {},
    el("h3", { style: { marginBottom: "10px" } }, "Balance on this endpoint"),

    app.agentToken
      ? el(
          "div",
          { class: "inset", style: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" } },
          app.agentBalance !== null
            ? el("span", { style: { fontWeight: "500" } }, `$${app.agentBalance} spendable`)
            : el("span", { class: "muted" }, "signed in"),
          el("span", { class: "mono", style: { fontSize: "13px" } }, maskToken(app.agentToken)),
          el("div", { class: "grow" }),
          el(
            "button",
            {
              class: "sm",
              onClick: () => {
                dropAgentToken();
                paintSource();
              },
            },
            "Forget",
          ),
        )
      : null,

    auth
      ? el(
          "div",
          { style: { marginTop: app.agentToken ? "10px" : "0" } },
          el(
            "button",
            {
              class: app.agentToken ? "sm" : "sm primary",
              disabled: !app.wallet || signInState.busy,
              onClick: () => void signInWithWallet(),
            },
            signInState.busy
              ? "Waiting for your wallet..."
              : app.agentToken
                ? "Sign in again"
                : "Sign in with this wallet",
          ),
          el(
            "span",
            { class: "help", style: { marginLeft: "10px" } },
            app.wallet ? "One signature, no payment, nothing on chain." : "Connect a wallet first.",
          ),
        )
      : null,

    signInState.error
      ? el("p", { class: "help", style: { marginTop: "8px", color: "var(--bad)" } }, signInState.error)
      : null,

    el(
      "p",
      { class: "help", style: { marginTop: "8px" } },
      "This endpoint asks for a minimum payment, so an order that costs less leaves the rest as balance here. The token is what spends it: no signature and nothing on chain, just the order. It stays in this browser, is never shown in full, and is stripped from exported runs.",
    ),
  );
}
