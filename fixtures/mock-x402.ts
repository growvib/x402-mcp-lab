// A controllable x402 + MCP server: correct by default, broken on demand.
//
// It exists twice over. The page and the e2e tests drive a full payment against it with no wallet
// and no money. The conformance suite is tested against it too, and that is the part that matters:
// a checker is only worth running if the failure it claims to catch has actually been made to
// happen. Every flaw below is one check's reason for existing, and test/unit/conformance.test.ts
// turns each of them on in turn and asserts that exactly that check goes red.
//
//   node fixtures/mock-x402.ts                       # a conformant resource on 127.0.0.1:4999
//   X402_FIXTURE_FLAWS=head-405,no-expose node ...   # break it for the whole process
//   POST /resource?flaws=amount-number               # or per request

import { createServer, type OutgoingHttpHeaders, type Server } from "node:http";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { asRecord, isRecord, type JsonRecord, readPath, tryParseJson } from "../src/lib/json.ts";
import { amountFor, catalogPage, PRODUCTS, productFor } from "./catalog.ts";

type Flaws = ReadonlySet<string>;
type Send = (status: number, payload: unknown, headers?: OutgoingHttpHeaders) => void;

function list(value: string | null | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const ENV_FLAWS = list(process.env.X402_FIXTURE_FLAWS);

const PAY_TO = "0x2222222222222222222222222222222222222222";
// ---------------------------------------------------------------------------
// The account: a balance, and the orders placed against it
// ---------------------------------------------------------------------------

interface PlacedOrder {
  order_id: string;
  tracking_code: string;
  status: string;
  charged_usd: number;
  balance_usd: number;
  agent_token: string;
  message?: string;
}

interface LedgerEntry {
  order_id: string;
  tracking_code: string;
  status: string;
  service_id: string;
  service_name: string;
  option_label: string;
  quantity: number;
  link: string;
  charged_usd: number;
  start_count: number;
  remains: number;
  delivery: {
    listed_start: string;
    start_within_minutes: number;
    started: boolean;
    start_overdue: boolean;
    note: string;
  };
  created_at: string;
  updated_at: string;
}

// The balance this demo account holds on the endpoint, and what it has already bought with it.
// A payment above an order's price adds to the first; an order paid from balance subtracts. Both
// live for the life of the process, which is one test or one walkthrough.
let balanceUsd = 1.86;
const placedFromBalance = new Map<string, PlacedOrder>();

const round = (value: number): number => Number(value.toFixed(6));

// The order-status read, shaped like GrowVib's GET /v1/agent/orders(/{id}): every order either path
// placed, newest first, projected to what a buyer may see. The status moves one step per read
// (PENDING, IN_PROGRESS, COMPLETED), which is not how a real order behaves and exactly what a
// refresh button needs to show that it re-read something.
const ledger: LedgerEntry[] = [];
const PROGRESS = ["PENDING", "IN_PROGRESS", "COMPLETED"] as const;

function recordOrder(order: PlacedOrder, body: JsonRecord): void {
  const { product: bought, variant, units } = productFor(body);
  const now = new Date().toISOString();
  ledger.unshift({
    order_id: order.order_id,
    tracking_code: order.tracking_code,
    status: order.status,
    service_id: bought.id,
    service_name: bought.title,
    option_label: variant.display_label,
    quantity: units,
    link: typeof body.link === "string" ? body.link : "",
    charged_usd: order.charged_usd,
    start_count: 0,
    remains: units,
    // The delivery block, as the real tracking read states it: the listed start window, whether
    // delivery has begun, and never an estimate of completion.
    delivery: {
      listed_start: "0-1 Hour",
      start_within_minutes: 60,
      started: false,
      start_overdue: false,
      note: "Delivery is gradual once it starts: remains counts down and completion time is not estimated.",
    },
    created_at: now,
    updated_at: now,
  });
}

function advance(entry: LedgerEntry): LedgerEntry {
  const index = PROGRESS.indexOf(entry.status as (typeof PROGRESS)[number]);
  const next = PROGRESS[Math.min(index + 1, PROGRESS.length - 1)] ?? entry.status;
  if (next !== entry.status) {
    entry.status = next;
    entry.remains = next === "COMPLETED" ? 0 : Math.ceil(entry.quantity / 2);
    entry.delivery = { ...entry.delivery, started: true };
    entry.updated_at = new Date().toISOString();
  }
  return entry;
}

// A token shaped like the real one: three dots, with an expiry a client can read.
function agentToken(): string {
  const claims = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `header.${claims}.sig`;
}

// ---------------------------------------------------------------------------
// The quote
// ---------------------------------------------------------------------------

const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FORGED_SIGNATURE = `0x${"ab".repeat(65)}`;

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");

function bodyOf(text: string): JsonRecord {
  return asRecord(tryParseJson(text));
}

interface Requirement {
  scheme: string;
  network: string;
  amount?: string | number;
  maxAmountRequired?: string | number;
  payTo: string;
  asset: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, string>;
}

// The Solana rail, shaped exactly like GrowVib's: the fee payer and a recent blockhash in `extra`,
// because the payer builds the whole transaction and cannot do it without them. The addresses are
// real mainnet ones (USDC and a wallet that holds it), so the token account derivation the page
// does is derived against something that exists rather than against invented bytes.
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_PAY_TO = "HiFZ2Q7BgmYDC6YqpigYQa5GAa2Sa2VZeozF6hYZxPCv";
const SOLANA_FEE_PAYER = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const SOLANA_BLOCKHASH = "GeU1ssVJ4Tp6meoGMigV6LFcWDApgZyvwpa2SZLvfd6A";

function solanaRequirements(flaws: Flaws, body: JsonRecord): Requirement {
  const extra: Record<string, string> = {
    feePayer: SOLANA_FEE_PAYER,
    recentBlockhash: SOLANA_BLOCKHASH,
    lastValidBlockHeight: "426194453",
  };
  // A quote with no fee payer is unpayable by anyone, which the page has to say rather than fail on.
  if (flaws.has("solana-no-fee-payer")) delete extra.feePayer;
  return {
    scheme: "exact",
    network: SOLANA_NETWORK,
    amount: amountFor(body),
    payTo: SOLANA_PAY_TO,
    asset: SOLANA_MINT,
    maxTimeoutSeconds: 300,
    extra,
  };
}

// settleSolana checks what a fixture can check: that the transaction is base64, that it carries two
// signature slots with the fee payer's still empty (the facilitator signs that one), and that the
// message behind them is the length a real one would be. It cannot verify a signature or touch a
// chain, and it does not pretend to.
function settleSolana(payload: JsonRecord, send: Send): void {
  const encoded = readPath(payload, "payload.transaction");
  if (typeof encoded !== "string" || !encoded) {
    send(400, { error: "the Solana payload carries no transaction" });
    return;
  }
  const raw = Buffer.from(encoded, "base64");
  if (raw.length < 200) {
    send(400, { error: "the transaction is not a serialized Solana transaction" });
    return;
  }
  if (raw[0] !== 2) {
    send(400, {
      error: `the transaction carries ${raw[0]} signature slots, want two: the payer's and the facilitator's`,
    });
    return;
  }
  const feePayerSlot = raw.subarray(1, 65);
  const payerSlot = raw.subarray(65, 129);
  if (!feePayerSlot.every((byte) => byte === 0)) {
    send(400, { error: "the fee payer's signature slot is filled; the facilitator has nowhere to sign" });
    return;
  }
  if (payerSlot.every((byte) => byte === 0)) {
    send(400, { error: "the paying wallet has not signed the transaction" });
    return;
  }
  // The message: header, key count, keys, blockhash, instructions.
  const message = raw.subarray(129);
  if (message[0] !== 2 || message.length < 300) {
    send(400, { error: "the transaction message is not the shape a payment takes" });
    return;
  }
  send(201, {
    order_id: `ord_sol_${(raw.length % 997).toString(36)}`,
    status: "PENDING",
    message: "Delivered. Settled on Solana.",
    charged_usd: 0.01,
    agent_token: agentToken(),
    balance_usd: balanceUsd,
  });
}

function requirements(flaws: Flaws, body: JsonRecord): Requirement {
  const req: Requirement = {
    scheme: "exact",
    network: "eip155:8453",
    amount: amountFor(body),
    payTo: PAY_TO,
    asset: ASSET,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
  if (flaws.has("amount-number")) req.amount = Number(req.amount);
  if (flaws.has("v1-amount")) {
    req.maxAmountRequired = req.amount;
    delete req.amount;
  }
  if (flaws.has("no-domain")) delete req.extra;
  if (flaws.has("bad-network")) req.network = "base";
  if (flaws.has("no-timeout")) delete req.maxTimeoutSeconds;
  return req;
}

interface QuoteDocument {
  x402Version: number;
  error: string;
  accepts: Requirement[];
  resource?: { url: string; description: string; mimeType: string; serviceName: string; tags: string[] };
  extensions?: { bazaar: JsonRecord };
}

interface SchemaField {
  type: string;
  description?: string;
  enum?: string[];
}

// The x402 v2 Bazaar declaration, in the shape the foundation's extension publishes and the real
// endpoint serves: the request described under info, the fields under schema.input.body.
function bazaarDeclaration(flaws: Flaws): JsonRecord {
  const quantity: SchemaField = { type: "integer", description: "How many copies." };
  if (flaws.has("no-descriptions")) delete quantity.description;
  return {
    info: {
      input: {
        type: "http",
        method: "POST",
        bodyType: "json",
        body: { item: "report", variant: "standard", quantity: 1 },
      },
      output: { type: "json", example: { order_id: "ord_1", status: "PENDING" } },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["input"],
      properties: {
        input: {
          type: "object",
          required: ["type", "method", "bodyType", "body"],
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", const: "POST" },
            bodyType: { type: "string", const: "json" },
            body: {
              type: "object",
              required: ["item", "quantity"],
              properties: {
                item: { type: "string", description: "Which product to buy.", enum: ["report", "export"] },
                variant: {
                  type: "string",
                  description: "Which variant. Each one has its own price.",
                  enum: ["standard", "priority", "csv", "parquet"],
                },
                quantity,
              },
            },
          },
        },
        output: {
          type: "object",
          required: ["type"],
          properties: { type: { type: "string" }, example: { type: "object" } },
        },
      },
    },
  };
}

function quoteDocument(flaws: Flaws, base: string, body: JsonRecord): QuoteDocument {
  const evm = requirements(flaws, body);
  const doc: QuoteDocument = {
    x402Version: 2,
    error: "payment required",
    accepts: flaws.has("no-solana") ? [evm] : [evm, solanaRequirements(flaws, body)],
    resource: {
      url: flaws.has("resource-relative") ? "/resource" : `${base}/resource`,
      description: "A demo resource, delivered on payment.",
      mimeType: "application/json",
      serviceName: "Fixture",
      tags: ["fixture", "testing"],
    },
    extensions: { bazaar: bazaarDeclaration(flaws) },
  };
  if (flaws.has("no-resource")) delete doc.resource;
  if (flaws.has("no-bazaar")) delete doc.extensions;
  if (flaws.has("no-accepts")) doc.accepts = [];
  return doc;
}

function driftedDoc(doc: QuoteDocument): QuoteDocument {
  const copy = structuredClone(doc);
  const [first] = copy.accepts;
  if (first) first.amount = "9900000";
  return copy;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

interface FixtureTool {
  name: string;
  description: string;
  inputSchema?: { type: "object"; required?: string[]; properties: Record<string, SchemaField> };
  annotations?: Record<string, boolean>;
}

function tools(flaws: Flaws): FixtureTool[] {
  const item: SchemaField = { type: "string", description: "Which widget to buy." };
  if (flaws.has("mcp-no-arg-descriptions")) delete item.description;
  const paid: FixtureTool = {
    name: "create_paid_order",
    description:
      "Buy a widget and pay for it with USDC, with no account. Call it first without the `payment` " +
      "argument to receive the payment requirements, sign them, then call it again with `payment` " +
      "set to the signed x402 payload.",
    inputSchema: {
      type: "object",
      required: ["item", "quantity"],
      properties: {
        item,
        quantity: { type: "integer", description: "How many." },
        payment: { type: "object", description: "The signed x402 payment payload. Omit on the first call." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  };
  const search: FixtureTool = {
    name: "search_catalog",
    description: flaws.has("mcp-dangling")
      ? "Find a widget to buy. When you have one, call place_order."
      : "Find a widget to buy. When you know which one you want, call create_paid_order.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "What to look for." } } },
    annotations: { readOnlyHint: true },
  };
  if (flaws.has("mcp-unmarked")) delete paid.annotations;
  if (flaws.has("mcp-no-schema")) delete search.inputSchema;
  return [search, paid];
}

function mcpAnswer(send: Send, body: string, flaws: Flaws, base: string): void {
  const message = bodyOf(body);
  const { id, method } = message;
  const params = asRecord(message.params);
  const reply = (result: unknown) => send(200, { jsonrpc: "2.0", id, result });

  if (method === "initialize") {
    reply({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture-mcp", version: "0.1.0" },
    });
    return;
  }
  if (method === "notifications/initialized") {
    send(202, null);
    return;
  }
  if (method === "tools/list") {
    reply({ tools: tools(flaws) });
    return;
  }
  if (method === "tools/call") {
    const args = asRecord(params.arguments);
    if (params.name !== "create_paid_order") {
      reply({ content: [{ type: "text", text: "[]" }], structuredContent: { results: [] } });
      return;
    }
    if (!args.payment) {
      const doc = quoteDocument(flaws, base, args);
      reply({
        content: [{ type: "text", text: "payment required" }],
        structuredContent: {
          payment_required: true,
          accepts: doc.accepts,
          resource: doc.resource,
          extensions: doc.extensions,
        },
      });
      return;
    }
    reply({
      content: [{ type: "text", text: "order placed" }],
      structuredContent: { order_id: "ord_mcp_1", status: "PENDING", charged_usd: 1.2 },
    });
    return;
  }
  send(200, { jsonrpc: "2.0", id, error: { code: -32601, message: `no method ${String(method)}` } });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function corsHeaders(flaws: Flaws): OutgoingHttpHeaders {
  if (flaws.has("no-cors")) return {};
  const headers: OutgoingHttpHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": flaws.has("no-allow-payment")
      ? "content-type"
      : "content-type,payment-signature,authorization,mcp-session-id,mcp-protocol-version",
    "access-control-allow-methods": "GET,POST,HEAD,OPTIONS",
  };
  if (!flaws.has("no-expose")) {
    headers["access-control-expose-headers"] = "PAYMENT-REQUIRED,PAYMENT-RESPONSE,EXTENSION-RESPONSES,Retry-After";
  }
  return headers;
}

function decodePaymentHeader(header: string): JsonRecord | null {
  const parsed = tryParseJson(Buffer.from(header, "base64").toString("utf8"));
  return isRecord(parsed) ? parsed : null;
}

function lower(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

export interface FixtureOptions {
  /** Flaws on for every request this server answers, on top of X402_FIXTURE_FLAWS and ?flaws=. */
  flaws?: readonly string[];
}

// createFixture returns a server rather than starting one, so the conformance tests can raise a
// broken fixture per flaw in-process and on an ephemeral port. Each flaw is one check's reason for
// existing, and a checker nobody has watched go red is a checker nobody should trust.
export function createFixture({ flaws: fixedFlaws = [] }: FixtureOptions = {}): Server {
  const orders = new Map<string, PlacedOrder>(); // nonce -> order: the replay guard
  const links = new Map<string, string>(); // target -> order id: the duplicate guard

  const server = createServer(async (req, res) => {
    const address = server.address();
    const base = `http://127.0.0.1:${address !== null && typeof address === "object" ? address.port : 0}`;
    const url = new URL(req.url ?? "/", base);
    const flaws: Flaws = new Set([...ENV_FLAWS, ...fixedFlaws, ...list(url.searchParams.get("flaws"))]);

    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");

    const send: Send = (status, payload, headers = {}) => {
      const raw = payload === null ? "" : JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", ...corsHeaders(flaws), ...headers });
      if (req.method === "HEAD") res.end();
      else res.end(raw);
    };

    if (req.method === "OPTIONS") {
      if (flaws.has("bad-preflight")) {
        send(404, { error: "no" });
        return;
      }
      res.writeHead(204, corsHeaders(flaws));
      res.end();
      return;
    }

    const path = url.pathname;

    if (path === "/.well-known/x402" && req.method === "GET") {
      if (flaws.has("no-well-known")) {
        send(404, { error: "not found" });
        return;
      }
      send(200, { x402Version: 2, kind: "resource-server", resources: [{ url: `${base}/resource`, method: "POST" }] });
      return;
    }

    if (path === "/mcp" && req.method === "POST") {
      mcpAnswer(send, body, flaws, base);
      return;
    }

    if (path === "/catalog" && req.method === "GET") {
      send(
        200,
        catalogPage({
          search: url.searchParams.get("search") ?? "",
          category: url.searchParams.get("category") ?? "",
          page: Number(url.searchParams.get("page")) || 1,
          pageSize: Math.min(50, Number(url.searchParams.get("page_size")) || 10),
        }),
      );
      return;
    }
    if (path.startsWith("/catalog/") && req.method === "GET") {
      const found = PRODUCTS.get(path.slice("/catalog/".length));
      if (!found) {
        send(404, { error: "no such product" });
        return;
      }
      send(200, { id: found.id, name: found.title, metadata: found.metadata, options: found.variants });
      return;
    }

    // The catalog and sign-in routes the GrowVib preset expects, so the preset can be driven
    // against this fixture without touching anything real.
    if (path.startsWith("/v1/services/")) {
      send(200, {
        id: "11111111-2222-3333-4444-555555555555",
        name: "Telegram Members",
        options: [
          {
            id: "opt-cheap",
            display_label: "Standard",
            slug: "tg-standard",
            price_usd: 1.2,
            min_quantity: 50,
            max_quantity: 100000,
            metadata: { link_type: "channel", start_label: "0-1 Hour" },
          },
          {
            id: "opt-premium",
            display_label: "High Quality",
            slug: "tg-hq",
            price_usd: 4.5,
            min_quantity: 500,
            max_quantity: 20000,
            metadata: { link_type: "channel", start_label: "0-6 Hours" },
          },
        ],
      });
      return;
    }
    if (path.startsWith("/v1/services")) {
      send(200, { data: [{ id: "11111111-2222-3333-4444-555555555555", title: "Telegram Members" }] });
      return;
    }
    if (path === "/v1/agent/auth/challenge") {
      // The `domain` line names the page that asked, taken from the Origin header, which is what
      // the real endpoint does and what stops a wallet flagging a domain mismatch on every honest
      // sign-in. `?domain=` forces a mismatch, for the spec that covers the warning.
      const forced = url.searchParams.get("domain");
      const asked = req.headers.origin ? new URL(req.headers.origin).host : "";
      const authority = forced || asked || "fixture";
      send(200, {
        nonce: "test-nonce-1",
        message:
          `${authority} wants you to sign in with your Ethereum account:\n` +
          "0x1111111111111111111111111111111111111111\n\nNonce: test-nonce-1",
        expires_at: new Date(Date.now() + 300000).toISOString(),
      });
      return;
    }
    if (path === "/v1/agent/auth/token") {
      const parsed = bodyOf(body);
      if (parsed.nonce !== "test-nonce-1" || !parsed.signature) {
        send(400, { error: "bad sign-in" });
        return;
      }
      send(200, {
        agent_token: agentToken(),
        address: "0x1111111111111111111111111111111111111111",
        balance_usd: balanceUsd,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
      return;
    }

    // The order reads. The agent token is the only credential, as on the real endpoint: a missing
    // one is 401 (there is nothing to pay for), an order this token does not own is 404.
    if (req.method === "GET" && (path === "/v1/agent/orders" || path.startsWith("/v1/agent/orders/"))) {
      if (!/^Bearer \S+/.test(String(req.headers.authorization ?? ""))) {
        send(401, { error: "an agent token is required: send it as Authorization: Bearer <agent_token>" });
        return;
      }
      if (path === "/v1/agent/orders") {
        const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size")) || 10));
        const status = url.searchParams.get("status");
        const rows = status ? ledger.filter((entry) => entry.status === status) : ledger;
        send(200, {
          data: rows.slice((page - 1) * pageSize, page * pageSize),
          page,
          page_size: pageSize,
          total: rows.length,
        });
        return;
      }
      const wanted = decodeURIComponent(path.slice("/v1/agent/orders/".length));
      const entry = ledger.find((row) => row.order_id === wanted);
      if (!entry) {
        send(404, { error: "order not found" });
        return;
      }
      send(200, advance(entry));
      return;
    }

    if (path !== "/resource" && path !== "/v1/agent/orders") {
      send(404, { error: "resource not found" });
      return;
    }

    if (req.method === "HEAD") {
      if (flaws.has("head-405")) {
        send(405, null, { allow: "POST" });
        return;
      }
      send(
        402,
        null,
        flaws.has("no-header") ? {} : { "PAYMENT-REQUIRED": b64(quoteDocument(flaws, base, bodyOf(body))) },
      );
      return;
    }

    // A bearer token spends a balance: no signature and nothing on chain.
    //
    // The three rules that matter are the server's, so they are the fixture's too: the key is
    // required, a repeat of the same key returns the first order rather than buying twice, and a
    // balance that does not cover the price is answered with the ordinary 402 rather than an
    // error, because the paying path is still open.
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (bearer && !req.headers["payment-signature"]) {
      const parsed = bodyOf(body);
      const key = String(parsed.idempotency_key ?? "");
      if (!key) {
        send(400, { error: "idempotency_key is required when paying from balance, so a retry cannot order twice" });
        return;
      }
      const repeated = placedFromBalance.get(key);
      if (repeated) {
        send(201, repeated);
        return;
      }

      const price = Number(amountFor(parsed)) / 1e6;
      if (price > balanceUsd) {
        const doc = quoteDocument(flaws, base, parsed);
        send(
          402,
          {
            ...doc,
            balance_usd: round(balanceUsd),
            agent_token: agentToken(),
            message: "Your balance does not cover this order. Pay to top up and place it.",
          },
          { "PAYMENT-REQUIRED": b64(doc) },
        );
        return;
      }

      balanceUsd = round(balanceUsd - price);
      const answer: PlacedOrder = {
        order_id: `ord_bal_${placedFromBalance.size + 1}`,
        tracking_code: `ORD-BAL${placedFromBalance.size + 1}`,
        status: "PENDING",
        charged_usd: round(price),
        balance_usd: balanceUsd,
        agent_token: agentToken(),
        message: "Order placed from your balance.",
      };
      placedFromBalance.set(key, answer);
      recordOrder(answer, parsed);
      send(201, answer);
      return;
    }

    const header = req.headers["payment-signature"];
    if (typeof header !== "string" || !header) {
      const doc = quoteDocument(flaws, base, bodyOf(body));
      const headers: OutgoingHttpHeaders = {};
      if (!flaws.has("no-header")) {
        headers["PAYMENT-REQUIRED"] = b64(flaws.has("header-drift") ? driftedDoc(doc) : doc);
      }
      send(402, doc, headers);
      return;
    }

    const payload = decodePaymentHeader(header);
    if (!payload) {
      if (flaws.has("crash-on-garbage")) send(500, { error: "unexpected end of JSON input" });
      else send(400, { error: "the payment header is not base64 JSON" });
      return;
    }

    // The Solana rail sends the transfer itself rather than an authorization to make one, so it
    // is a different payload and a different set of things to check.
    if (readPath(payload, "accepted.network") === SOLANA_NETWORK || readPath(payload, "payload.transaction")) {
      settleSolana(payload, send);
      return;
    }

    const authorized = isRecord(readPath(payload, "payload.authorization"));
    const auth = asRecord(readPath(payload, "payload.authorization"));
    const signature = readPath(payload, "payload.signature");
    const accepted = asRecord(payload.accepted);
    if (flaws.has("accept-forged")) {
      send(201, { order_id: "ord_forged", status: "PENDING", message: "settled without checking" });
      return;
    }
    if (signature === FORGED_SIGNATURE) {
      send(402, { error: "the authorization was not accepted", accepts: [requirements(flaws, bodyOf(body))] });
      return;
    }

    const nonce = typeof auth.nonce === "string" ? auth.nonce : "";
    const problems: string[] = [];
    if (payload.x402Version !== 2) problems.push("x402Version");
    if (accepted.scheme !== "exact") problems.push("scheme");
    if (lower(accepted.payTo) !== PAY_TO.toLowerCase()) problems.push("payTo");
    if (!signature) problems.push("signature");
    if (lower(auth.to) !== PAY_TO.toLowerCase()) problems.push("authorization.to");
    if (!/^0x[0-9a-f]{64}$/i.test(nonce)) problems.push("nonce");
    if (!authorized || Number(auth.validBefore) <= Math.floor(Date.now() / 1000)) problems.push("expired");
    if (problems.length) {
      send(400, { error: `rejected: ${problems.join(", ")}` });
      return;
    }

    const settled = { success: true, transaction: `0xdeadbeef${"00".repeat(28)}`, network: "eip155:8453" };
    const indexed = readPath(payload, "resource.url")
      ? { bazaar: { status: "processing" } }
      : { bazaar: { status: "rejected", rejectedReason: "failed to enqueue discovery cataloging" } };
    const headers = { "PAYMENT-RESPONSE": b64(settled), "EXTENSION-RESPONSES": b64(indexed) };

    // The replay guard: the identical payload returns the identical outcome and settles nothing.
    const replayed = orders.get(nonce);
    if (replayed) {
      send(201, { ...replayed, replayed: true }, headers);
      return;
    }

    const parsedBody = bodyOf(body);
    const target = String(parsedBody.link || parsedBody.item || "");
    const inProgress = target ? links.get(target) : undefined;
    if (inProgress && !flaws.has("no-duplicate-guard")) {
      send(409, { error: "an order for this target is already in progress", order_id: inProgress });
      return;
    }

    // The figures are derived from what was actually authorized, so the result screen cannot show
    // a charge that disagrees with the quote the payer just read.
    const settledAmount = Number(auth.value ?? 0) / 1e6;
    const price = Number(amountFor(parsedBody)) / 1e6;
    const order: PlacedOrder = {
      order_id: `ord_${orders.size + 1}`,
      tracking_code: `FX-${1000 + orders.size}`,
      status: "PENDING",
      charged_usd: round(price),
      balance_usd: round(Math.max(0, settledAmount - price)),
      agent_token: agentToken(),
    };
    orders.set(nonce, order);
    recordOrder(order, parsedBody);
    if (target) links.set(target, order.order_id);
    send(201, order, headers);
  });

  return server;
}

// Started only when run directly, so importing it for a test costs nothing.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  const port = Number(process.env.PORT || 4999);
  createFixture().listen(port, "127.0.0.1", () => {
    console.log(`fixture x402 resource on http://127.0.0.1:${port}/resource`);
    if (ENV_FLAWS.length) console.log(`deliberately broken: ${ENV_FLAWS.join(", ")}`);
  });
}
