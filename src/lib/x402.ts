// The x402 protocol model: parsing a 402, reading a requirement, and assembling the payload.
//
// Pure functions only. No DOM, no network, no wallet. The page, the headless CLI and the unit
// tests all run this same code, which is the only way the report a CI run prints can be trusted
// to mean what the page means.
//
// Field naming is deliberately tolerant in one place and strict everywhere else: the amount
// arrives as `amount` from x402 v2 servers and as `maxAmountRequired` from ones still on the v1
// spelling, and refusing to read a quote over that would make the tool useless against half the
// resources it exists to inspect. Everything else is read as the spec names it.

import { errorMessage, isRecord, tryParseJson } from "./json.ts";

export const X402_VERSION = 2;

// ---------------------------------------------------------------------------
// The documents. Every field is optional: these are read off servers under test, and a missing
// field is a finding to report, not a type error to crash on.
// ---------------------------------------------------------------------------

export interface RequirementExtra {
  /** EIP-712 domain name of the token (Base). */
  name?: string;
  /** EIP-712 domain version of the token (Base). */
  version?: string;
  /** The account that pays the Solana transaction fee. */
  feePayer?: string;
  decimals?: number;
  [key: string]: unknown;
}

export interface PaymentRequirement {
  scheme?: string;
  network?: string;
  /** Atomic units, x402 v2. */
  amount?: string;
  /** Atomic units, the x402 v1 spelling. */
  maxAmountRequired?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  resource?: string;
  description?: string;
  mimeType?: string;
  extra?: RequirementExtra;
}

export interface ResourceInfo {
  url?: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
}

export interface PaymentRequired {
  x402Version?: number;
  error?: string;
  resource?: ResourceInfo;
  accepts?: PaymentRequirement[];
  extensions?: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  accepted: PaymentRequirement;
  payload: unknown;
  resource?: ResourceInfo;
  extensions?: Record<string, unknown>;
}

export type Rail = "evm" | "solana" | "unknown";

// ---------------------------------------------------------------------------
// base64 JSON, the envelope every x402 header uses
// ---------------------------------------------------------------------------

export type Decoded = { ok: true; value: unknown; text: string } | { ok: false; error: string; text?: string };

/**
 * decodeBase64Json never throws. A malformed header is a FINDING on the server being tested, not
 * an exception in the tester, and the caller needs the raw text to show what arrived.
 */
export function decodeBase64Json(value: unknown): Decoded {
  if (typeof value !== "string" || value === "") return { ok: false, error: "empty" };
  let text: string;
  try {
    const binary = atob(value.trim());
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    text = new TextDecoder().decode(bytes);
  } catch (error) {
    return { ok: false, error: `not base64: ${errorMessage(error)}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown, text };
  } catch (error) {
    return { ok: false, error: `not JSON: ${errorMessage(error)}`, text };
  }
}

export function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Reading a 402
// ---------------------------------------------------------------------------

export interface Parity {
  ok: boolean;
  why: string;
}

export interface Quote {
  status: number;
  /** The payment requirements from the JSON body. */
  doc: PaymentRequired | null;
  /** The same document decoded from the PAYMENT-REQUIRED header. */
  headerDoc: PaymentRequired | null;
  /** Whether the two copies agree, or null when there is only one to judge. */
  parity: Parity | null;
  error: string | null;
}

function asDocument(value: unknown): PaymentRequired | null {
  return isRecord(value) ? (value as PaymentRequired) : null;
}

/**
 * parseQuote reads the two copies of the payment requirements a compliant server sends: the JSON
 * body and the PAYMENT-REQUIRED header. Both are returned, along with whether they agree.
 *
 * They are checked against each other rather than one being preferred, because a header that has
 * drifted from the body is a real and silent failure mode: a browser client reads the header, a
 * server-to-server client reads the body, and the two then pay different amounts.
 */
export function parseQuote({
  status,
  body,
  headers = {},
}: {
  status: number;
  body: string;
  headers?: Record<string, string>;
}): Quote {
  const out: Quote = { status, doc: null, headerDoc: null, parity: null, error: null };

  if (body.trim() !== "") {
    try {
      out.doc = asDocument(JSON.parse(body));
    } catch (error) {
      out.error = `402 body is not JSON: ${errorMessage(error)}`;
    }
  } else {
    out.error = "402 with an empty body";
  }

  const raw = headers["payment-required"] ?? headers["PAYMENT-REQUIRED"];
  if (raw) {
    const decoded = decodeBase64Json(raw);
    if (decoded.ok) out.headerDoc = asDocument(decoded.value);
    else out.parity = { ok: false, why: `PAYMENT-REQUIRED ${decoded.error}` };
  }

  if (out.doc && out.headerDoc) {
    const same = stableJson(out.doc) === stableJson(out.headerDoc);
    out.parity = same
      ? { ok: true, why: "the header decodes to the same document as the body" }
      : { ok: false, why: "the header and the body describe different payments" };
  } else if (out.doc && !raw) {
    out.parity = { ok: false, why: "no PAYMENT-REQUIRED header, so a browser client learns nothing" };
  }

  return out;
}

/**
 * stableJson orders keys so two documents that differ only in key order compare equal. JSON object
 * key order is not significant, and reporting it as a mismatch would be a false alarm of exactly
 * the kind that gets a check switched off.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export interface Amount {
  value: unknown;
  /** Which spelling carried it, so the conformance suite can say so. */
  field: "amount" | "maxAmountRequired" | null;
}

/** The atomic amount under either spelling, and which one was found. */
export function requirementAmount(req: unknown): Amount {
  if (!isRecord(req)) return { value: null, field: null };
  if (req.amount !== undefined && req.amount !== null) return { value: req.amount, field: "amount" };
  if (req.maxAmountRequired !== undefined && req.maxAmountRequired !== null) {
    return { value: req.maxAmountRequired, field: "maxAmountRequired" };
  }
  return { value: null, field: null };
}

export interface Caip2 {
  ok: boolean;
  namespace: string | null;
  reference: string | null;
  /** The numeric chain id of an `eip155:` network; null for a non-numeric reference. */
  chainId: number | null;
}

/**
 * parseCaip2 splits a CAIP-2 network id. `eip155:8453` carries a numeric chain id; `solana:<hash>`
 * carries a genesis-block reference that is not a number, which is why chainId is nullable rather
 * than defaulted to zero.
 */
export function parseCaip2(network: unknown): Caip2 {
  const text = typeof network === "string" ? network : "";
  const at = text.indexOf(":");
  if (at <= 0 || at === text.length - 1) return { ok: false, namespace: null, reference: null, chainId: null };
  const namespace = text.slice(0, at);
  const reference = text.slice(at + 1);
  const chainId = /^\d+$/.test(reference) ? Number(reference) : null;
  return { ok: /^[a-z0-9-]{3,8}$/.test(namespace), namespace, reference, chainId };
}

/**
 * railOf says which signer can pay a requirement. Anything else is listed and left alone: a rail
 * this tool cannot sign for is not a defect in the quote.
 */
export function railOf(req: PaymentRequirement | null | undefined): Rail {
  const { namespace } = parseCaip2(req?.network);
  if (namespace === "eip155") return "evm";
  if (namespace === "solana") return "solana";
  return "unknown";
}

export interface RailedRequirement {
  index: number;
  req: PaymentRequirement;
  rail: Rail;
}

/**
 * selectRequirements returns every accepts entry with its rail, in the order the server listed
 * them. Order is preserved because x402 makes the first entry the default for a client that reads
 * only one, so a tool that reordered them would be testing a quote nobody is served.
 */
export function selectRequirements(doc: PaymentRequired | null | undefined): RailedRequirement[] {
  const accepts = Array.isArray(doc?.accepts) ? doc.accepts : [];
  return accepts.map((req, index) => ({ index, req, rail: railOf(req) }));
}

// ---------------------------------------------------------------------------
// Money. String and BigInt arithmetic throughout.
// ---------------------------------------------------------------------------

/**
 * atomicToDecimal converts an atomic amount to an exact decimal string. Number() on a uint256
 * loses precision above 2^53, and this is the value a payer authorizes.
 */
export function atomicToDecimal(atomic: unknown, decimals: number): string | null {
  const digits = String(atomic ?? "0").replace(/^0+(?=\d)/, "") || "0";
  if (!/^\d+$/.test(digits)) return null;
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * formatUsd is atomicToDecimal for READING: two places minimum, never truncated, so a price does
 * not render as "$1.5" and a sub-cent amount still shows in full.
 */
export function formatUsd(atomic: unknown, decimals: number): string | null {
  const exact = atomicToDecimal(atomic, decimals);
  if (exact === null) return null;
  const [whole, frac = ""] = exact.split(".");
  return frac.length >= 2 ? exact : `${whole}.${frac.padEnd(2, "0")}`;
}

/**
 * decimalToAtomic turns a typed ceiling ("5.00") into atomic units so a spend limit is compared
 * the same way the amount is carried. A ceiling compared as a float is a ceiling that rounds.
 */
export function decimalToAtomic(value: unknown, decimals: number): bigint | null {
  const text = String(value ?? "").trim();
  if (!/^\d*(\.\d*)?$/.test(text) || text === "" || text === ".") return null;
  const [whole = "0", frac = ""] = text.split(".");
  // More precision than the token has. Truncating would quietly RAISE a ceiling, so it is refused.
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function isAtomicString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value) && value.length <= 78;
}

// ---------------------------------------------------------------------------
// The payload a client sends back
// ---------------------------------------------------------------------------

/**
 * buildPaymentPayload assembles what travels in PAYMENT-SIGNATURE (or in an MCP tool's `payment`
 * argument, which carries the identical object).
 *
 * `accepted` echoes the server's own requirement verbatim: the server compares it against what it
 * issued and forwards ITS copy to the facilitator, so editing it gets a payment refused, never
 * repriced.
 *
 * `resource` and `extensions` are copied from the 402 because x402 v2 makes that the CLIENT's job
 * and the facilitator indexes what it finds in the PAYLOAD. Dropping `extensions` leaves the
 * resource unlisted silently; dropping `resource` is worse, since the declaration then validates
 * and the catalog job fails for an empty url, which reads like a facilitator outage. Neither is
 * part of what was signed, so copying them changes nothing about the money.
 */
export function buildPaymentPayload({
  doc,
  requirement,
  proof,
}: {
  doc: PaymentRequired | null | undefined;
  requirement: PaymentRequirement;
  proof: unknown;
}): PaymentPayload {
  const payload: PaymentPayload = {
    x402Version: doc?.x402Version ?? X402_VERSION,
    accepted: requirement,
    payload: proof,
  };
  if (doc?.resource) payload.resource = doc.resource;
  if (doc?.extensions) payload.extensions = doc.extensions;
  return payload;
}

/**
 * resourceUrl reads the url the facilitator would index this resource under. It is read from the
 * `resource` block only, exactly as the SDK's extractor does, so this reports what will actually
 * be catalogued rather than what the operator meant.
 */
export function resourceUrl(doc: PaymentRequired | null | undefined): string | null {
  const url = doc?.resource?.url;
  return typeof url === "string" && url !== "" ? url : null;
}

/**
 * What the endpoint said about a refusal, when it said anything.
 *
 * `details` first, then `error`, then `message`: that is the order this family of APIs puts the
 * specific sentence in, and the general one ("Invalid input: ...") wraps it with a category nobody
 * needs to read twice. An endpoint that bothers to explain itself has written the most useful
 * sentence available, and a status code is not a substitute for it.
 */
export function serverSays(body: unknown): string {
  const parsed = tryParseJson(body);
  if (!isRecord(parsed)) return "";
  for (const key of ["details", "error", "message"]) {
    const message = parsed[key];
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return "";
}
