// The balance path, with the transport and the signer injected.
//
// The assertions worth having here are about what is on the wire, because this endpoint decides
// which of two ways to pay it is looking at from exactly that: a bearer token with no payment
// header IS the balance order. Get it wrong in the safe direction and a price check places an
// order.

import assert from "node:assert/strict";
import test from "node:test";

import {
  challengeAuthority,
  coverage,
  idempotencyKeyFor,
  listOrders,
  orderFromBalance,
  ordersOf,
  readBalance,
  readOrder,
  signIn,
  walletAuthOf,
} from "../../src/lib/agent.ts";
import { asRecord } from "../../src/lib/json.ts";
import type { Http, HttpRequest } from "../../src/lib/types.ts";
import { failed, present, succeeded, targetOf } from "./support.ts";

const TARGET = targetOf({
  method: "POST",
  resource: "/v1/agent/orders",
  walletAuth: { challenge: "/v1/agent/auth/challenge", token: "/v1/agent/auth/token", tokenField: "agent_token" },
});

interface Reply {
  status: number;
  body: unknown;
}

function transport(responses: Reply[]): { http: Http; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const queue = [...responses];
  const http: Http = async (request) => {
    calls.push(request);
    const next = queue.shift() ?? { status: 500, body: "{}" };
    return {
      headers: {},
      status: next.status,
      body: typeof next.body === "string" ? next.body : JSON.stringify(next.body),
    };
  };
  return { http, calls };
}

/** The nth request the transport saw, failing the test when there were fewer. */
function call(calls: HttpRequest[], index: number): HttpRequest {
  return present(calls[index], `request ${index}`);
}

const CHALLENGE = { status: 200, body: { nonce: "n-1", message: "example.com wants you to sign in...\nNonce: n-1" } };
const TOKEN = {
  status: 200,
  body: { agent_token: "tok-1", address: "0xabc", balance_usd: 5.709225, expires_at: "2026-09-17T13:00:00Z" },
};

test("signing in signs the message the server sent, unchanged", async () => {
  const { http, calls } = transport([CHALLENGE, TOKEN]);
  const signed: string[] = [];
  const result = await signIn({
    http,
    target: TARGET,
    address: "0xabc",
    sign: async (message) => {
      signed.push(message);
      return "0xsig";
    },
  });

  assert.equal(signed.length, 1);
  assert.equal(signed[0], CHALLENGE.body.message, "the message was altered before signing");
  assert.equal(call(calls, 0).path, "/v1/agent/auth/challenge");
  assert.deepEqual(call(calls, 0).body, { address: "0xabc", chain: "eip155" });
  assert.deepEqual(call(calls, 1).body, { nonce: "n-1", signature: "0xsig" });
  const signedIn = succeeded(result);
  assert.equal(signedIn.token, "tok-1");
  assert.equal(signedIn.balance, 5.709225);
});

test("a refused signature is an answer, not a crash", async () => {
  const { http, calls } = transport([CHALLENGE]);
  const result = await signIn({
    http,
    target: TARGET,
    address: "0xabc",
    sign: async () => {
      throw new Error("User rejected the request");
    },
  });
  assert.match(failed(result), /User rejected/);
  assert.ok(!("token" in result), "a refused signature produced a token");
  assert.equal(calls.length, 1, "it posted the signature anyway");
});

test("the authority the message names is read out of the message", () => {
  // What a wallet compares against the page, and therefore the only thing worth comparing. Read
  // from the signed bytes rather than guessed from the source's origin: the endpoint decides what
  // goes in that field, and guessing produced a domain warning on every sign-in including the ones
  // with nothing wrong with them.
  assert.equal(
    challengeAuthority("api.growvib.com wants you to sign in with your Ethereum account:\n0xabc"),
    "api.growvib.com",
  );
  assert.equal(
    challengeAuthority("localhost:4999 wants you to sign in with your Solana account:\nSoL"),
    "localhost:4999",
  );
  assert.equal(challengeAuthority(""), "");
  assert.equal(challengeAuthority("a message about something else entirely"), "");
  assert.equal(challengeAuthority(undefined), "");
});

test("the authority is reported before the wallet is asked to sign", async () => {
  // The order matters and is the whole point: a page that explains a domain warning after the
  // signature has been taken explained it to somebody who already decided.
  const { http } = transport([CHALLENGE, TOKEN]);
  const events: string[] = [];
  const result = await signIn({
    http,
    target: TARGET,
    address: "0xabc",
    onChallenge: ({ authority }) => {
      events.push(`challenge:${authority}`);
    },
    sign: async () => {
      events.push("sign");
      return "0xsig";
    },
  });

  assert.deepEqual(
    events,
    ["challenge:example.com", "sign"],
    "the page learned the authority too late to say anything",
  );
  assert.equal(succeeded(result).authority, "example.com");
});

test("a callback that throws does not abandon a sign-in in progress", async () => {
  const { http } = transport([CHALLENGE, TOKEN]);
  const result = await signIn({
    http,
    target: TARGET,
    address: "0xabc",
    onChallenge: () => {
      throw new Error("the screen failed to paint");
    },
    sign: async () => "0xsig",
  });
  assert.equal(succeeded(result).token, "tok-1", "a rendering failure lost a signature that was about to be taken");
});

test("a refused sign-in reports what the endpoint said, not what it answered", async () => {
  // The server writes the most useful sentence available here and it says what to do next. The
  // first version of this threw it away in favour of "the sign-in answered 400", which is how
  // three rounds of "it still does not work" happened: the commonest cause is the five minute
  // challenge expiring while the wallet dialog sits open, and the server says so.
  const refusal = {
    status: 400,
    body: { error: "this sign-in could not be verified. Request a new challenge and sign it again" },
  };
  const { http } = transport([CHALLENGE, refusal]);
  const result = await signIn({ http, target: TARGET, address: "0xabc", sign: async () => "0xsig" });

  const error = failed(result);
  assert.match(error, /Request a new challenge/, `the endpoint's own words were dropped: ${error}`);
  assert.match(error, /400/, "the status is gone, and it is worth keeping alongside the sentence");
  assert.ok(
    "retryable" in result && result.retryable,
    "a refused sign-in is worth pressing again, and the page needs to know",
  );
  assert.ok(!("token" in result));
});

test("a refusal with no explanation still says something", async () => {
  const { http } = transport([CHALLENGE, { status: 503, body: "<html>gateway</html>" }]);
  const result = await signIn({ http, target: TARGET, address: "0xabc", sign: async () => "0xsig" });
  assert.match(failed(result), /answered 503/, `an unexplained refusal lost its status too: ${failed(result)}`);
});

test("a challenge the endpoint refuses says why", async () => {
  const { http, calls } = transport([{ status: 400, body: { error: "that looks like a Solana address" } }]);
  const result = await signIn({ http, target: TARGET, address: "SoLana", sign: async () => "0xsig" });
  assert.match(failed(result), /Solana address/);
  assert.equal(calls.length, 1, "it went on to the signature after the challenge was refused");
});

test("a sign-in that answers without a token is not treated as a sign-in", async () => {
  const { http } = transport([CHALLENGE, { status: 200, body: { address: "0xabc" } }]);
  const result = await signIn({ http, target: TARGET, address: "0xabc", sign: async () => "0xsig" });
  assert.match(failed(result), /no agent_token/);
});

test("a balance order carries the token and the key, and no payment header", async () => {
  const { http, calls } = transport([
    { status: 201, body: { order_id: "ord_1", charged_usd: 0.07, balance_usd: 5.64 } },
  ]);
  await orderFromBalance({
    http,
    target: TARGET,
    body: { service_id: "svc", quantity: 100, link: "https://t.me/x" },
    token: "tok-1",
    idempotencyKey: "key-1",
  });

  const sent = call(calls, 0);
  assert.equal(sent.method, "POST");
  assert.equal(sent.path, "/v1/agent/orders");
  assert.equal(sent.headers?.authorization, "Bearer tok-1");
  assert.equal(asRecord(sent.body).idempotency_key, "key-1");
  // The header is what makes the server take the settling path. Its absence is the whole point.
  const headers = Object.keys(sent.headers ?? {}).map((name) => name.toLowerCase());
  assert.ok(!headers.includes("payment-signature"), "a payment header was attached to a balance order");
});

test("a balance order without a token or a key is refused before it is sent", async () => {
  const { http, calls } = transport([]);
  assert.match(
    failed(await orderFromBalance({ http, target: TARGET, body: {}, token: null, idempotencyKey: "k" })),
    /Sign in/,
  );
  assert.match(
    failed(await orderFromBalance({ http, target: TARGET, body: {}, token: "t", idempotencyKey: null })),
    /idempotency/,
  );
  assert.equal(calls.length, 0);
});

test("the idempotency key follows what is being bought", () => {
  const body = { service_id: "svc", quantity: 100, link: "https://t.me/x" };
  // The same order, asked for twice, is one key: that is what makes a retry safe.
  assert.equal(idempotencyKeyFor(body), idempotencyKeyFor({ ...body }));
  // Key order in the object is not part of the order.
  assert.equal(
    idempotencyKeyFor(body),
    idempotencyKeyFor({ link: "https://t.me/x", quantity: 100, service_id: "svc" }),
  );
  // A different order is a different key, or the server refuses it as a reused one.
  assert.notEqual(idempotencyKeyFor(body), idempotencyKeyFor({ ...body, quantity: 200 }));
  assert.notEqual(idempotencyKeyFor(body), idempotencyKeyFor({ ...body, link: "https://t.me/y" }));
  // And a deliberate second identical order can be asked for with a salt.
  assert.notEqual(idempotencyKeyFor(body), idempotencyKeyFor(body, "again"));
});

test("coverage compares in cents and says how far short", () => {
  assert.deepEqual(coverage({ balance: 5.709225, price: 0.07 }), { known: true, covers: true, short: 0 });
  assert.deepEqual(coverage({ balance: 0.05, price: 1 }), { known: true, covers: false, short: 0.95 });
  // Exactly enough is enough.
  assert.equal(coverage({ balance: 1, price: 1 }).covers, true);
  // A balance nobody reported is not a balance of zero.
  assert.equal(coverage({ balance: null, price: 1 }).known, false);
  assert.equal(coverage({ balance: null, price: 1 }).covers, false);
});

test("the preset's field names are configuration, not knowledge", () => {
  assert.equal(walletAuthOf(targetOf({ walletAuth: { challenge: "/c", token: "/t" } }))?.tokenField, "agent_token");
  assert.equal(
    walletAuthOf(targetOf({ walletAuth: { challenge: "/c", token: "/t", tokenField: "jwt" } }))?.tokenField,
    "jwt",
  );
  assert.equal(walletAuthOf(targetOf()), null);
  assert.equal(readBalance({ credit: 4 }, "credit"), 4);
  assert.equal(readBalance({}), null);
});

// --- reading orders back -----------------------------------------------------------------------

const ORDERS_TARGET = {
  ...TARGET,
  orders: { list: "/v1/agent/orders", get: "/v1/agent/orders/{id}", idField: "order_id" },
};

/** The headers of a request, never absent. */
const headersOf = (request: HttpRequest): Record<string, string> => request.headers ?? {};

test("an order read is a GET with the token and nothing that could pay", async () => {
  const { http, calls } = transport([
    { status: 200, body: { order_id: "a/b", status: "IN_PROGRESS", option_label: "High Quality" } },
  ]);
  const result = await readOrder({ http, target: ORDERS_TARGET, token: "tok-1", id: "a/b" });

  assert.equal(succeeded(result).order.status, "IN_PROGRESS");
  assert.equal(calls.length, 1);
  const sent = call(calls, 0);
  assert.equal(sent.method, "GET");
  // Encoded: an id is data from a response, and must not be able to become another path.
  assert.equal(sent.path, "/v1/agent/orders/a%2Fb");
  assert.equal(headersOf(sent).authorization, "Bearer tok-1");
  assert.equal(sent.body, undefined, "a read carried a body");
  assert.ok(!Object.keys(headersOf(sent)).some((name) => /payment/i.test(name)), "a read carried a payment header");
});

test("an order read without a token or an endpoint asks nothing", async () => {
  const { http, calls } = transport([]);
  assert.match(failed(await readOrder({ http, target: ORDERS_TARGET, token: null, id: "x" })), /agent token/);
  assert.match(failed(await readOrder({ http, target: TARGET, token: "t", id: "x" })), /does not publish/);
  assert.equal(calls.length, 0);
  assert.equal(ordersOf(TARGET), null);
});

test("an order read that is refused says why, by status", async () => {
  const { http } = transport([
    { status: 401, body: { error: "token expired" } },
    { status: 404, body: { error: "not found" } },
  ]);
  assert.match(failed(await readOrder({ http, target: ORDERS_TARGET, token: "t", id: "x" })), /401.*token expired/);
  assert.match(failed(await readOrder({ http, target: ORDERS_TARGET, token: "t", id: "x" })), /no such order/);
});

test("the order list asks for one page and reports the endpoint's own total", async () => {
  const { http, calls } = transport([
    { status: 200, body: { data: [{ order_id: "o1" }, { order_id: "o2" }], page: 2, page_size: 2, total: 7 } },
  ]);
  const result = succeeded(await listOrders({ http, target: ORDERS_TARGET, token: "tok-1", page: 2, pageSize: 2 }));

  assert.deepEqual(
    result.orders.map((order) => order.order_id),
    ["o1", "o2"],
  );
  assert.equal(result.total, 7, "the total is the endpoint's, not the length of the page");
  assert.equal(result.page, 2);
  const sent = call(calls, 0);
  assert.equal(sent.method, "GET");
  assert.equal(sent.path, "/v1/agent/orders?page=2&page_size=2");
  assert.equal(headersOf(sent).authorization, "Bearer tok-1");
});

test("an order list that is not a page is refused rather than read as empty", async () => {
  const { http } = transport([{ status: 200, body: { orders: [] } }]);
  assert.match(failed(await listOrders({ http, target: ORDERS_TARGET, token: "t" })), /page of orders/);
});
