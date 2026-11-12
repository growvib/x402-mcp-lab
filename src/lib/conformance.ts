// The conformance suite: what a client, a directory and a browser agent each need from an x402
// resource, checked one statement at a time.
//
// Three rules keep the report worth pasting into an issue:
//
//  1. A check that could not run reports `skip` and says why. It is never folded into the pass
//     count. A green report that quietly skipped the money checks is how a broken payment path
//     ships with a badge on it.
//  2. Nothing here spends. The one probe that sends a payment header sends a deliberately invalid
//     signature, which cannot authorize a transfer at the token level, and it says so in its
//     title. The checks that need real money are declared and skipped unless the caller opts in.
//  3. Every finding names the spec section or the concrete consequence, never a vendor. The
//     maintainer receiving the report has to be able to act on it without this tool.

import { isAddress } from "./abi.ts";
import { bazaarBodySchema } from "./bazaar.ts";
import { asRecord, errorMessage, tryParseJson } from "./json.ts";
import { createMcpClient, danglingToolReferences, looksLikeSpending, type McpTool } from "./mcp.ts";
import type { Http, HttpResponse } from "./types.ts";
import {
  encodeBase64Json,
  isAtomicString,
  parseCaip2,
  parseQuote,
  type Quote,
  requirementAmount,
  selectRequirements,
} from "./x402.ts";

export type Outcome = "pass" | "fail" | "warn" | "skip";

export const PASS = "pass";
export const FAIL = "fail";
export const WARN = "warn";
export const SKIP = "skip";

export interface ConformanceCheck {
  id: string;
  group: string;
  title: string;
  /** The spec section, or the concrete consequence, this statement comes from. */
  spec: string;
  state: Outcome;
  detail: string;
}

/** The resource under test. */
export interface SuiteTarget {
  url: string;
  method?: string;
  body?: unknown;
  mcpEndpoint?: string;
}

export interface SuiteOptions {
  /** Send the two refusal probes (a malformed header and a forged signature). On by default. */
  probe?: boolean;
  /** A facilitator discovery index to look the resource up in. */
  facilitator?: string;
  /** Whether a funded wallet is available, which changes what the money checks say. */
  funded?: boolean;
}

export interface Report {
  checks: ConformanceCheck[];
  counts: Record<Outcome, number>;
  quote: Quote | null;
  raw?: HttpResponse;
}

type Record_ = (entry: ConformanceCheck) => ConformanceCheck;

const PROBE_ORIGIN = "https://x402-lab.invalid";

function check(id: string, group: string, title: string, spec: string): ConformanceCheck {
  return { id, group, title, spec, state: SKIP, detail: "not run" };
}

function settle(entry: ConformanceCheck, state: Outcome, detail: string): ConformanceCheck {
  entry.state = state;
  entry.detail = detail;
  return entry;
}

/**
 * Walks the phases in dependence order: the quote first, since almost everything is a statement
 * about it, then the probes that need their own request, then MCP.
 */
export async function runSuite({
  http,
  target,
  options = {},
}: {
  http: Http;
  target: SuiteTarget;
  options?: SuiteOptions;
}): Promise<Report> {
  const results: ConformanceCheck[] = [];
  const record: Record_ = (entry) => {
    results.push(entry);
    return entry;
  };

  const method = (target.method || "POST").toUpperCase();
  const quoteRes = await http({
    method,
    url: target.url,
    headers: { accept: "application/json", origin: PROBE_ORIGIN },
    body: method === "GET" || method === "HEAD" ? undefined : (target.body ?? {}),
  });

  const reachable = record(check("reachable", "402 document", "The resource answers", "x402 v2 §4"));
  if (quoteRes.transportError) {
    settle(reachable, FAIL, `could not be reached: ${quoteRes.transportError}`);
    return summarise(results, { quote: null });
  }
  settle(reachable, PASS, `${quoteRes.status} in ${quoteRes.ms ?? "?"} ms`);

  const answers402 = record(check("status-402", "402 document", "An unpaid request is answered 402", "x402 v2 §4"));
  if (quoteRes.status !== 402) {
    settle(
      answers402,
      FAIL,
      `answered ${quoteRes.status}. ${
        quoteRes.status === 404
          ? "The resource may be switched off, or the path is wrong."
          : "A paid resource asks for payment before it does the work."
      }`,
    );
    return summarise(results, { quote: null, raw: quoteRes });
  }
  settle(answers402, PASS, "402 Payment Required");

  const quote = parseQuote({ status: quoteRes.status, body: quoteRes.body, headers: quoteRes.headers });
  for (const entry of documentChecks(quote)) record(entry);

  await headerChecks({ http, target, method, record, quoteRes });
  await discoveryChecks({ http, target, quote, record, options });
  if (options.probe !== false) await refusalChecks({ http, target, method, quote, record });
  if (target.mcpEndpoint) await mcpChecks({ http, endpoint: target.mcpEndpoint, record });
  moneyChecks({ record, options });

  return summarise(results, { quote, raw: quoteRes });
}

// ---------------------------------------------------------------------------
// The document, checked without any further request
// ---------------------------------------------------------------------------

export function documentChecks(quote: Quote): ConformanceCheck[] {
  const out: ConformanceCheck[] = [];
  const doc = quote.doc;

  const json = check("body-json", "402 document", "The body is the payment requirements as JSON", "x402 v2 §4");
  out.push(doc ? settle(json, PASS, "parsed") : settle(json, FAIL, quote.error ?? "not JSON"));
  if (!doc) return out;

  const version = check("version", "402 document", "x402Version is present and is 2", "x402 v2 §4");
  out.push(
    doc.x402Version === 2
      ? settle(version, PASS, "2")
      : doc.x402Version
        ? settle(version, WARN, `reports version ${doc.x402Version}; this tool signs v2`)
        : settle(version, FAIL, "missing, so a client cannot tell which envelope it is reading"),
  );

  const entries = selectRequirements(doc);
  const accepts = check("accepts", "402 document", "accepts carries at least one payment requirement", "x402 v2 §5");
  if (entries.length === 0) {
    out.push(settle(accepts, FAIL, "empty, so there is nothing a client can pay"));
    return out;
  }
  out.push(
    settle(
      accepts,
      PASS,
      `${entries.length} entr${entries.length === 1 ? "y" : "ies"}: ${entries.map((e) => e.req.network).join(", ")}`,
    ),
  );

  const problems: string[] = [];
  const warnings: string[] = [];
  for (const { req, index, rail } of entries) {
    const at = `accepts[${index}]`;
    const { value: amount, field } = requirementAmount(req);
    if (!isAtomicString(amount)) {
      problems.push(
        `${at}: the amount must be a string of digits in atomic units${typeof amount === "number" ? " (a JSON number loses uint256 precision)" : ""}`,
      );
    } else if (field === "maxAmountRequired") {
      warnings.push(`${at}: uses the v1 spelling maxAmountRequired; v2 clients read amount`);
    }
    if (!parseCaip2(req.network).ok) problems.push(`${at}: network ${JSON.stringify(req.network)} is not a CAIP-2 id`);
    if (!req.payTo) problems.push(`${at}: no payTo, so there is nobody to pay`);
    if (rail === "evm" && !isAddress(req.payTo)) problems.push(`${at}: payTo is not an EVM address`);
    if (!req.asset) problems.push(`${at}: no asset`);
    if (req.scheme !== "exact") {
      warnings.push(`${at}: scheme ${JSON.stringify(req.scheme)} is not the exact scheme most clients implement`);
    }
    if (!Number.isFinite(Number(req.maxTimeoutSeconds)) || Number(req.maxTimeoutSeconds) <= 0) {
      problems.push(`${at}: maxTimeoutSeconds must say how long the quote stays payable`);
    }
    if (rail === "evm" && (!req.extra?.name || !req.extra?.version)) {
      problems.push(
        `${at}: extra.name and extra.version are the EIP-712 domain the payer signs under; without them a client has to guess`,
      );
    }
    if (rail === "solana" && !req.extra?.feePayer) {
      problems.push(`${at}: a Solana requirement must name the facilitator's feePayer`);
    }
  }

  const fields = check(
    "accepts-fields",
    "402 document",
    "Every requirement carries the fields a signer needs",
    "x402 v2 §5",
  );
  out.push(
    problems.length
      ? settle(fields, FAIL, problems.join("; "))
      : warnings.length
        ? settle(fields, WARN, warnings.join("; "))
        : settle(fields, PASS, "scheme, network, amount, payTo, asset, maxTimeoutSeconds and the signing domain"),
  );

  const parity = check(
    "header-parity",
    "402 document",
    "PAYMENT-REQUIRED decodes to the same document as the body",
    "x402 v2 §4",
  );
  out.push(
    quote.parity?.ok
      ? settle(parity, PASS, quote.parity.why)
      : settle(
          parity,
          FAIL,
          `${quote.parity?.why ?? "no header"}. A browser client reads the header and a server-to-server client reads the body, so a drift between them means the two pay different things`,
        ),
  );

  return out;
}

// ---------------------------------------------------------------------------
// What a browser agent needs, which is the part servers forget
// ---------------------------------------------------------------------------

async function headerChecks({
  http,
  target,
  method,
  record,
  quoteRes,
}: {
  http: Http;
  target: SuiteTarget;
  method: string;
  record: Record_;
  quoteRes: HttpResponse;
}): Promise<void> {
  const expose = (quoteRes.headers["access-control-expose-headers"] ?? "").toLowerCase();
  const allowOrigin = quoteRes.headers["access-control-allow-origin"];

  const cors = record(
    check("cors-origin", "Browser clients", "The 402 is readable cross-origin", "fetch living standard"),
  );
  if (!allowOrigin) {
    settle(
      cors,
      WARN,
      "no Access-Control-Allow-Origin, so a wallet-driven agent in a browser cannot read this answer at all. Server-to-server clients never notice",
    );
  } else {
    settle(cors, PASS, `Access-Control-Allow-Origin: ${allowOrigin}`);
  }

  const exposed = record(
    check("cors-expose", "Browser clients", "The x402 response headers are exposed to script", "fetch living standard"),
  );
  const missing = ["payment-required", "payment-response"].filter((h) => !expose.includes(h));
  if (!allowOrigin) {
    settle(exposed, SKIP, "not cross-origin readable at all, so there is nothing to expose yet");
  } else if (missing.length === 0) {
    settle(exposed, PASS, expose);
  } else {
    settle(
      exposed,
      FAIL,
      `missing from Access-Control-Expose-Headers: ${missing.join(", ")}. A browser client then sees a 402 with an empty header and cannot learn what to sign`,
    );
  }

  const preflight = record(
    check(
      "cors-preflight",
      "Browser clients",
      "A preflight allows the PAYMENT-SIGNATURE request header",
      "fetch living standard",
    ),
  );
  const pre = await http({
    method: "OPTIONS",
    url: target.url,
    headers: {
      origin: PROBE_ORIGIN,
      "access-control-request-method": method,
      "access-control-request-headers": "payment-signature,content-type",
    },
  });
  if (pre.transportError) {
    settle(preflight, SKIP, pre.transportError);
  } else {
    const allow = (pre.headers["access-control-allow-headers"] ?? "").toLowerCase();
    if (pre.status >= 400)
      settle(preflight, FAIL, `the preflight answered ${pre.status}, so the paying request is never sent`);
    else if (allow.includes("payment-signature") || allow === "*") settle(preflight, PASS, allow);
    else {
      settle(
        preflight,
        FAIL,
        `Access-Control-Allow-Headers does not list payment-signature (got ${allow || "nothing"})`,
      );
    }
  }

  const head = record(
    check("head-probe", "Discovery", "HEAD answers the challenge instead of 405", "draft-hawkins-x402-dns-discovery"),
  );
  const probe = await http({ method: "HEAD", url: target.url, headers: { origin: PROBE_ORIGIN } });
  if (probe.transportError) {
    settle(head, SKIP, probe.transportError);
  } else if (probe.status === 405) {
    settle(
      head,
      FAIL,
      "405. Directories probe a candidate resource with HEAD and read the requirements out of the PAYMENT-REQUIRED header; a 405 reads as 'not an x402 resource' and the resource is never listed",
    );
  } else if (probe.status === 402 && probe.headers["payment-required"]) {
    settle(head, PASS, "402 with the requirements in the header");
  } else if (probe.status === 402) {
    settle(head, WARN, "402 but no PAYMENT-REQUIRED header, so a HEAD probe learns nothing");
  } else {
    settle(head, WARN, `answered ${probe.status}`);
  }
}

// ---------------------------------------------------------------------------
// Being findable
// ---------------------------------------------------------------------------

async function discoveryChecks({
  http,
  target,
  quote,
  record,
  options,
}: {
  http: Http;
  target: SuiteTarget;
  quote: Quote;
  record: Record_;
  options: SuiteOptions;
}): Promise<void> {
  const doc = quote.doc;

  const resource = record(
    check("resource-block", "Discovery", "The 402 describes the resource it is selling", "x402 bazaar"),
  );
  const url = doc?.resource?.url;
  if (!doc?.resource) {
    settle(
      resource,
      WARN,
      "no resource block. The facilitator reads the listing url from the payload's resource block, so a payment that carries no resource is indexed under an empty url and the catalog job is rejected",
    );
  } else if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    settle(resource, FAIL, `resource.url is ${JSON.stringify(url)}; it has to be the absolute url a client would call`);
  } else {
    settle(resource, PASS, url);
  }

  const bazaar = record(
    check("bazaar", "Discovery", "The Bazaar declaration describes how to call the resource", "x402 bazaar"),
  );
  const declaration = doc?.extensions?.bazaar;
  const schema = bazaarBodySchema(declaration);
  const properties = schema?.properties;
  if (!declaration) {
    settle(
      bazaar,
      WARN,
      "no extensions.bazaar, so nothing indexes this resource and an agent that finds it cannot tell what to send",
    );
  } else if (!properties) {
    settle(
      bazaar,
      WARN,
      "the declaration carries no input schema with properties, so a client cannot build a request from it",
    );
  } else {
    settle(bazaar, PASS, `${Object.keys(properties).length} documented input fields`);
  }

  const described = record(
    check("bazaar-descriptions", "Discovery", "Every required input field is described", "x402 bazaar"),
  );
  if (!properties) {
    settle(described, SKIP, "no input schema to read");
  } else {
    const required = Array.isArray(schema?.required) ? schema.required : Object.keys(properties);
    const undocumented = required.filter((key) => !properties[key]?.description);
    if (undocumented.length === 0) settle(described, PASS, `${required.length} required fields, all described`);
    else {
      settle(
        described,
        WARN,
        `no description for ${undocumented.join(", ")}. An agent picking this resource out of a directory has only these sentences to go on`,
      );
    }
  }

  const wellKnown = record(
    check(
      "well-known",
      "Discovery",
      "The domain publishes an x402 capability manifest",
      "draft-hawkins-x402-dns-discovery",
    ),
  );
  const targetUrl = new URL(target.url);
  const manifest = await http({
    method: "GET",
    url: `${targetUrl.origin}/.well-known/x402`,
    headers: { accept: "application/json" },
  });
  if (manifest.transportError) settle(wellKnown, SKIP, manifest.transportError);
  else if (manifest.status === 404) {
    settle(wellKnown, WARN, "no /.well-known/x402. A crawler that has only the domain has nothing to read");
  } else if (manifest.status !== 200) settle(wellKnown, WARN, `answered ${manifest.status}`);
  else {
    // Re-serialised rather than searched raw, so an escaped "\/v1\/orders" still matches.
    const parsed = tryParseJson(manifest.body);
    const names = parsed !== undefined && JSON.stringify(parsed).includes(targetUrl.pathname);
    settle(
      wellKnown,
      names ? PASS : WARN,
      names ? "published and names this resource" : "published but does not name this resource",
    );
  }

  const listed = record(
    check("facilitator-index", "Discovery", "The resource appears in the facilitator's index", "x402 bazaar"),
  );
  if (!options.facilitator) {
    settle(listed, SKIP, "no facilitator index configured");
  } else if (!url) {
    settle(listed, SKIP, "no resource.url to look for");
  } else {
    const index = await http({ method: "GET", url: options.facilitator, headers: { accept: "application/json" } });
    if (index.transportError || index.status !== 200) {
      settle(listed, SKIP, index.transportError ?? `the index answered ${index.status}`);
    } else {
      const found = index.body.includes(url);
      settle(
        listed,
        found ? PASS : WARN,
        found
          ? "listed"
          : "not in the index. Listing happens when a payment carrying the declaration settles, so this is expected until the first one does",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// How refusals are answered. Nothing here can move money.
// ---------------------------------------------------------------------------

async function refusalChecks({
  http,
  target,
  method,
  quote,
  record,
}: {
  http: Http;
  target: SuiteTarget;
  method: string;
  quote: Quote;
  record: Record_;
}): Promise<void> {
  const garbage = record(
    check("malformed-payment", "Refusals", "A malformed PAYMENT-SIGNATURE is refused, not crashed on", "x402 v2 §7"),
  );
  const bad = await http({
    method,
    url: target.url,
    headers: { "payment-signature": "this-is-not-base64-json", accept: "application/json" },
    body: target.body ?? {},
  });
  if (bad.transportError) settle(garbage, SKIP, bad.transportError);
  else if (bad.status >= 500) {
    settle(
      garbage,
      FAIL,
      `answered ${bad.status}. A client sending a broken header should be told so, not handed a server error it cannot act on`,
    );
  } else if (bad.status === 402 || bad.status === 400)
    settle(garbage, PASS, `${bad.status} with the requirements repeated`);
  else settle(garbage, WARN, `answered ${bad.status}`);

  const forged = record(
    check("forged-signature", "Refusals", "A well formed payload with an invalid signature is refused", "x402 v2 §7"),
  );
  const entry = selectRequirements(quote.doc).find((e) => e.rail === "evm");
  if (!entry) {
    settle(forged, SKIP, "no EVM requirement to forge against");
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const { value: amount } = requirementAmount(entry.req);
  const payload = {
    x402Version: 2,
    accepted: entry.req,
    payload: {
      // A signature of alternating bytes. It cannot authorize a transfer: the token recovers a
      // different signer and reverts, and the facilitator refuses it before that. This probe is
      // safe by construction, which is why it runs by default.
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        to: entry.req.payTo,
        value: String(amount ?? "1"),
        validAfter: String(now - 60),
        validBefore: String(now + 300),
        nonce: `0x${"cd".repeat(32)}`,
      },
    },
  };
  const res = await http({
    method,
    url: target.url,
    headers: { "payment-signature": encodeBase64Json(payload), accept: "application/json" },
    body: target.body ?? {},
  });
  if (res.transportError) settle(forged, SKIP, res.transportError);
  else if (res.status === 200 || res.status === 201) {
    settle(
      forged,
      FAIL,
      `answered ${res.status} for a payload nothing signed. Verify the payment before doing the work`,
    );
  } else if (res.status >= 500) {
    settle(forged, FAIL, `answered ${res.status}; an unsigned payload should be a refusal, not a server error`);
  } else settle(forged, PASS, `${res.status}, nothing was delivered`);
}

// ---------------------------------------------------------------------------
// MCP, when the target has one
// ---------------------------------------------------------------------------

async function mcpChecks({ http, endpoint, record }: { http: Http; endpoint: string; record: Record_ }): Promise<void> {
  const handshake = record(check("mcp-initialize", "MCP", "The server completes an MCP initialize", "MCP 2025-06-18"));
  const client = createMcpClient({ http, endpoint });
  try {
    const info = asRecord(await client.initialize());
    const server = asRecord(info.serverInfo);
    settle(
      handshake,
      PASS,
      `${String(server.name ?? "server")} ${String(server.version ?? "")} speaking ${String(info.protocolVersion ?? "")}`,
    );
  } catch (error) {
    settle(handshake, FAIL, errorMessage(error));
    return;
  }

  const list = record(check("mcp-tools", "MCP", "tools/list answers with tools", "MCP 2025-06-18"));
  let tools: McpTool[];
  try {
    tools = await client.listTools();
    settle(
      list,
      tools.length ? PASS : WARN,
      tools.length ? `${tools.length}: ${tools.map((t) => t.name).join(", ")}` : "no tools",
    );
  } catch (error) {
    settle(list, FAIL, errorMessage(error));
    return;
  }

  const schemas = record(
    check("mcp-schemas", "MCP", "Every tool has a description and an input schema", "MCP 2025-06-18"),
  );
  const thin = tools.filter((t) => !t.description || !t.inputSchema);
  settle(
    schemas,
    thin.length ? FAIL : PASS,
    thin.length
      ? `no description or schema on ${thin.map((t) => t.name).join(", ")}`
      : `${tools.length} tools documented`,
  );

  const args = record(check("mcp-arg-descriptions", "MCP", "Required arguments are described", "MCP 2025-06-18"));
  const undocumented: string[] = [];
  for (const tool of tools) {
    const props = tool.inputSchema?.properties ?? {};
    for (const key of tool.inputSchema?.required ?? []) {
      if (!props[key]?.description) undocumented.push(`${tool.name}.${key}`);
    }
  }
  settle(
    args,
    undocumented.length ? WARN : PASS,
    undocumented.length ? `no description: ${undocumented.join(", ")}` : "every required argument says what it takes",
  );

  const annotations = record(
    check("mcp-annotations", "MCP", "A tool that spends says so in its annotations", "MCP 2025-06-18"),
  );
  const unmarked = tools.filter((t) => looksLikeSpending(t) && t.annotations?.destructiveHint !== true);
  settle(
    annotations,
    unmarked.length ? WARN : PASS,
    unmarked.length
      ? `${unmarked.map((t) => t.name).join(", ")} look like spending tools but do not declare destructiveHint. A client cannot tell which call costs money`
      : "declared",
  );

  const dangling = record(
    check(
      "mcp-dangling",
      "MCP",
      "No description routes an agent to a tool this server does not register",
      "MCP 2025-06-18",
    ),
  );
  const findings = danglingToolReferences(tools);
  settle(
    dangling,
    findings.length ? FAIL : PASS,
    findings.length
      ? findings.map((f) => `${f.tool} points at ${f.names}`).join("; ")
      : "every tool named in a description is on this server",
  );
}

// ---------------------------------------------------------------------------
// The checks that need a funded wallet, declared whether or not they run
// ---------------------------------------------------------------------------

function moneyChecks({ record, options }: { record: Record_; options: SuiteOptions }): void {
  const declared: Array<[string, string, string]> = [
    [
      "replay",
      "Replaying the identical signed payload returns the same result and settles nothing further",
      "x402 v2 §10.1",
    ],
    ["duplicate", "A second order for the same target is refused before any payment", "resource policy"],
  ];
  for (const [id, title, spec] of declared) {
    settle(
      record(check(`money-${id}`, "Money", title, spec)),
      SKIP,
      options.funded
        ? "run it from the playground, which has the wallet"
        : "needs a funded wallet and a real settlement, so it is never inferred from a dry run",
    );
  }
}

// ---------------------------------------------------------------------------

export function summarise(results: ConformanceCheck[], extra: { quote: Quote | null; raw?: HttpResponse }): Report {
  const counts: Record<Outcome, number> = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const entry of results) counts[entry.state] += 1;
  return { checks: results, counts, ...extra };
}

const ORDER: Record<Outcome, number> = { fail: 0, warn: 1, pass: 2, skip: 3 };
const LABEL: Record<Outcome, string> = { fail: "FAIL", warn: "WARN", pass: "ok", skip: "skipped" };

/**
 * A report for an issue thread: the failures first, because that is what the maintainer reading it
 * needs, and the skips named so nobody reads the total as a score.
 */
export function toMarkdown(report: Report, target?: { url?: string }): string {
  const lines = [
    `### x402 conformance: ${target?.url || "resource"}`,
    "",
    `${report.counts.pass} passed · ${report.counts.fail} failed · ${report.counts.warn} warnings · ${report.counts.skip} skipped`,
    "",
  ];
  for (const entry of [...report.checks].sort((a, b) => ORDER[a.state] - ORDER[b.state])) {
    lines.push(`- **${LABEL[entry.state]}** ${entry.title} (${entry.spec})`, `  ${entry.detail}`);
  }
  lines.push("", "_Skipped checks are not passes. The money checks need a funded wallet and a real settlement._");
  return lines.join("\n");
}
