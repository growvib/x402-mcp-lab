// Paying out of a balance the endpoint already holds for you.
//
// The x402 handshake settles on chain, and a resource with a minimum payment leaves the difference
// as spendable balance whenever the order costs less. Without a way to spend that balance, every
// order settles again: an agent buying ten cheap things pays ten minimums and strands the rest. So
// the endpoint offers a second way to pay for the same thing:
//
//   1. Prove which wallet is asking, by signing an ERC-4361 message. No payment, nothing on chain.
//   2. Send the order with that token and an idempotency key, and no payment header at all.
//
// This module is the client half. It is pure apart from the injected transport and the injected
// signer, which is why it can be tested without a browser or a chain.
//
// One rule is load bearing and is the reason the quote step must NOT carry a token: on this kind
// of endpoint, a request with a bearer token and no payment IS the balance order. Attaching a token
// to a request meant as a price check would place an order. The quote stays anonymous, and the
// token appears only on the request somebody pressed a button to send.

import { asRecord, errorMessage, isRecord, type JsonRecord, numberOf, tryParseJson } from "./json.ts";
import type { Http, HttpResponse, Target } from "./types.ts";
import { serverSays } from "./x402.ts";

export interface WalletAuth {
  challenge: string;
  token: string;
  tokenField: string;
  balanceField: string;
}

export function walletAuthOf(target: Target | null | undefined): WalletAuth | null {
  const auth = target?.walletAuth;
  if (!auth?.challenge || !auth.token) return null;
  return {
    challenge: auth.challenge,
    token: auth.token,
    tokenField: auth.tokenField || "agent_token",
    balanceField: auth.balanceField || "balance_usd",
  };
}

export type SignInResult =
  | {
      error: null;
      authority: string;
      token: string;
      balance: number | null;
      address: string;
      expiresAt: string | null;
    }
  | { error: string; retryable?: boolean };

function parseObject(body: string, what: string): { value: JsonRecord } | { error: string } {
  try {
    return { value: asRecord(JSON.parse(body)) };
  } catch (error) {
    return { error: `${what} is not JSON: ${errorMessage(error)}` };
  }
}

function refusal(res: HttpResponse, what: string): string {
  return `${serverSays(res.body) || `${what} answered ${res.status}`} (HTTP ${res.status})`;
}

/**
 * Runs the two legged ERC-4361 exchange. `sign` is the wallet's personal_sign, injected so that
 * nothing here needs a wallet to be tested.
 *
 * Failures come back as a message rather than an exception: a refused signature is the most common
 * outcome of this button and is not an error worth a stack trace.
 */
export async function signIn({
  http,
  target,
  address,
  sign,
  chain = "eip155",
  onChallenge,
}: {
  http: Http;
  target: Target | null;
  address: string | null | undefined;
  sign: (message: string) => Promise<string>;
  chain?: string;
  onChallenge?: (challenge: { authority: string; message: string }) => void;
}): Promise<SignInResult> {
  const auth = walletAuthOf(target);
  if (!auth) return { error: "This source does not publish a wallet sign-in." };
  if (!address) return { error: "Connect a wallet first: the sign-in proves which wallet is asking." };

  const asked = await http({
    method: "POST",
    path: auth.challenge,
    headers: { "content-type": "application/json" },
    body: { address, chain },
    note: "Wallet sign-in challenge",
  });
  if (asked.transportError) return { error: asked.transportError };
  if (asked.status !== 200) return { error: refusal(asked, "the challenge") };

  const parsedChallenge = parseObject(asked.body, "the challenge");
  if ("error" in parsedChallenge) return parsedChallenge;
  const { message, nonce } = parsedChallenge.value;
  // The message is signed as it arrived, byte for byte. The server hashes exactly these bytes, so
  // trimming it or rebuilding it from parts produces a well formed signature over something else.
  if (typeof message !== "string" || !message || !nonce) {
    return { error: "the challenge carried no message to sign" };
  }

  // Told before the wallet opens, not after. An ERC-4361 message names the authority asking for
  // it, and a wallet compares that against the page: when the two differ it shows a red warning on
  // a prompt about money, and meeting that for the first time inside the wallet reads as an
  // attack. So the page says which name the message carries while the dialog is still opening.
  const authority = challengeAuthority(message);
  try {
    onChallenge?.({ authority, message });
  } catch {
    // A screen that failed to paint is not a reason to abandon a sign-in in progress.
  }

  let signature: string;
  try {
    signature = await sign(message);
  } catch (error) {
    return { error: `the wallet did not sign: ${errorMessage(error)}` };
  }
  if (!signature) return { error: "the wallet returned no signature" };

  const exchanged = await http({
    method: "POST",
    path: auth.token,
    headers: { "content-type": "application/json" },
    body: { nonce, signature },
    note: "Wallet sign-in signature",
  });
  if (exchanged.transportError) return { error: exchanged.transportError };
  if (exchanged.status !== 200) {
    // The server's own sentence, not a status code. The commonest cause is the clock: a challenge
    // is signable for a few minutes, and a wallet dialog left open while somebody reads the domain
    // warning can outlive it.
    return { error: refusal(exchanged, "the sign-in"), retryable: true };
  }

  const parsedResult = parseObject(exchanged.body, "the sign-in");
  if ("error" in parsedResult) return parsedResult;
  const result = parsedResult.value;

  const token = result[auth.tokenField];
  if (typeof token !== "string" || !token) return { error: `the sign-in returned no ${auth.tokenField}` };
  return {
    error: null,
    authority,
    token,
    balance: readBalance(result, auth.balanceField),
    address: typeof result.address === "string" && result.address ? result.address : address,
    expiresAt: typeof result.expires_at === "string" ? result.expires_at : null,
  };
}

/**
 * Sends the order the token pays for. No payment header, by design: the header is what would make
 * the server take the settling path instead.
 */
export async function orderFromBalance({
  http,
  target,
  body,
  token,
  idempotencyKey,
}: {
  http: Http;
  target: Target;
  body: JsonRecord | null | undefined;
  token: string | null | undefined;
  idempotencyKey: string | null | undefined;
}): Promise<{ res: HttpResponse; error: string | null } | { res?: undefined; error: string }> {
  if (!token) return { error: "No agent token. Sign in with the wallet that holds the balance." };
  if (!idempotencyKey) return { error: "No idempotency key, so this request cannot be made safely." };

  const res = await http({
    method: target.method || "POST",
    path: target.resource,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: { ...body, idempotency_key: idempotencyKey },
    note: "Order paid from balance",
  });
  return { res, error: res.transportError ?? null };
}

/**
 * The key is derived from WHAT is being bought, not from when the button was pressed.
 *
 * The server refuses a key reused for a different order and answers a repeat of the same one with
 * the order it already placed. So a key per request would defeat the retry protection (a retry
 * after a timeout would buy twice), and a key per session would collide the moment the selection
 * changes. A key per selection is the shape that matches both rules.
 */
export function idempotencyKeyFor(body: unknown, salt = ""): string {
  return `x402-lab-${hash(`${salt}:${JSON.stringify(sorted(body ?? {}))}`)}`;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  }
  return value;
}

/** A short, stable, non-cryptographic digest (FNV-1a). It names a request; it does not protect one. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
}

/**
 * The `domain` of an ERC-4361 message: the first line is "<authority> wants you to sign in with
 * your <chain> account:", and that authority is what a wallet compares against the page. Read from
 * the message rather than taken from a field, because the message is the only thing signed.
 */
export function challengeAuthority(message: unknown): string {
  const first = String(message ?? "").split("\n")[0] ?? "";
  return /^(\S+) wants you to sign in\b/.exec(first)?.[1] ?? "";
}

export function readBalance(parsed: unknown, field = "balance_usd"): number | null {
  return numberOf(asRecord(parsed)[field]) ?? null;
}

export interface Coverage {
  known: boolean;
  covers: boolean;
  /** How far short, in dollars; 0 when it covers, null when unknown. */
  short: number | null;
}

/**
 * Whether a balance covers a price, with the shortfall, so the screen can say how far short rather
 * than only that it is short.
 */
export function coverage({ balance, price }: { balance: number | null; price: number | null }): Coverage {
  if (balance === null || price === null || !Number.isFinite(balance) || !Number.isFinite(price)) {
    return { known: false, covers: false, short: null };
  }
  // Compared in cents, because a float comparison at the boundary decides a payment on a rounding
  // error. Rounded rather than truncated so 0.07 does not become 6 cents.
  const have = Math.round(balance * 100);
  const need = Math.round(price * 100);
  return { known: true, covers: have >= need, short: have >= need ? 0 : (need - have) / 100 };
}

// ---------------------------------------------------------------------------
// Reading orders back
//
// An order response is a snapshot of the moment it was placed: PENDING, every time. What happened
// next is a second question, asked of the endpoint's order read with the same agent token. Both
// reads are GETs and carry no payment, so neither can buy anything; the token is still a secret,
// so it goes in the header and nowhere else.
// ---------------------------------------------------------------------------

/** An order as the endpoint reports it. Every field is optional: this is somebody else's JSON. */
export interface Order {
  order_id?: string;
  tracking_code?: string;
  status?: string;
  service_name?: string;
  option_label?: string;
  quantity?: number;
  remains?: number | null;
  charged_usd?: number | string;
  updated_at?: string;
  posts?: number;
  delivery?: Delivery;
  [field: string]: unknown;
}

export interface Delivery {
  listed_start?: string;
  start_within_minutes?: number;
  started?: boolean;
  start_overdue?: boolean;
  waiting_for_post?: boolean;
  note?: string;
}

export interface OrdersApi {
  list: string | null;
  get: string | null;
  idField: string;
}

export function ordersOf(target: Target | null | undefined): OrdersApi | null {
  const orders = target?.orders;
  if (!orders?.list && !orders?.get) return null;
  return { list: orders.list || null, get: orders.get || null, idField: orders.idField || "order_id" };
}

export type OrderRead = { order: Order; error?: undefined } | { error: string; status?: number };

/**
 * One order by id. The id goes into the path encoded: it came from a server response, and a value
 * that is not an id should not be able to become a different path.
 */
export async function readOrder({
  http,
  target,
  token,
  id,
}: {
  http: Http;
  target: Target | null;
  token: string | null;
  id: string | null | undefined;
}): Promise<OrderRead> {
  const orders = ordersOf(target);
  if (!orders?.get) return { error: "This source does not publish an order read." };
  if (!token) return { error: "No agent token. Sign in with the wallet that paid to read its orders." };
  if (!id) return { error: "No order id to read." };
  const res = await http({
    method: "GET",
    path: orders.get.replace("{id}", encodeURIComponent(id)),
    headers: { authorization: `Bearer ${token}` },
    note: "Order status read",
  });
  if (res.transportError) return { error: res.transportError };
  if (res.status !== 200) return { error: orderReadError(res), status: res.status };
  const order = tryParseJson(res.body);
  return isRecord(order) ? { order: order as Order } : { error: "The order read did not answer with JSON." };
}

export type OrderPage =
  | { orders: Order[]; page: number; pageSize: number; total: number; error?: undefined }
  | { error: string; status?: number };

/**
 * One page of the token's orders, newest first. The page is the endpoint's, and so is the total: a
 * count this page worked out for itself would be a count of what it happened to have loaded.
 */
export async function listOrders({
  http,
  target,
  token,
  page = 1,
  pageSize = 10,
}: {
  http: Http;
  target: Target | null;
  token: string | null;
  page?: number;
  pageSize?: number;
}): Promise<OrderPage> {
  const orders = ordersOf(target);
  if (!orders?.list) return { error: "This source does not publish an order list." };
  if (!token) return { error: "No agent token. Sign in with the wallet that paid to list its orders." };
  const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  const res = await http({
    method: "GET",
    path: `${orders.list}${orders.list.includes("?") ? "&" : "?"}${query}`,
    headers: { authorization: `Bearer ${token}` },
    note: "Order list read",
  });
  if (res.transportError) return { error: res.transportError };
  if (res.status !== 200) return { error: orderReadError(res), status: res.status };
  const parsed = asRecord(tryParseJson(res.body));
  if (!Array.isArray(parsed.data)) return { error: "The order list did not answer with a page of orders." };
  const rows = parsed.data.filter(isRecord) as Order[];
  return {
    orders: rows,
    page: numberOf(parsed.page) || page,
    pageSize: numberOf(parsed.page_size) || pageSize,
    total: numberOf(parsed.total) ?? rows.length,
  };
}

function orderReadError(res: HttpResponse): string {
  const said = serverSays(res.body);
  const suffix = said ? ` ${said}` : "";
  if (res.status === 401) {
    return `The endpoint did not accept the agent token (401). Sign in again with the wallet that paid.${suffix}`;
  }
  if (res.status === 404) return "The endpoint has no such order for this wallet (404).";
  return `The order read answered ${res.status}.${suffix}`;
}
