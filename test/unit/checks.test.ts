// The pre-flight table, row by row.
//
// The rows that matter here are the ones that BLOCK. A check table that cannot fail is
// decoration, and an `unchecked` row rendered as a pass is worse than no row: the payTo row in
// the first version of this tool could not fail unless you had pinned an address, and it looked
// reassuring either way.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blockers,
  type CheckRow,
  type Facts,
  type Limits,
  preflight,
  type TokenReadings,
  unchecked,
} from "../../src/lib/checks.ts";
import {
  atomicToDecimal,
  decimalToAtomic,
  formatUsd,
  type PaymentRequirement,
  parseQuote,
  type RequirementExtra,
} from "../../src/lib/x402.ts";
import { malformed, present } from "./support.ts";

const REQUIREMENT: PaymentRequirement = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "1500000",
  payTo: "0x2222222222222222222222222222222222222222",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};

const FACTS = {
  requirement: REQUIREMENT,
  doc: { resource: { url: "https://example.test/resource" } },
  wallet: { address: "0x1111111111111111111111111111111111111111", chainId: 8453, balanceAtomic: "42000000" },
  token: {
    decimals: 6,
    name: "USD Coin",
    version: "2",
    symbol: "USDC",
    domainSeparator: "0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f",
  },
  guards: { maxSpend: "5.00", expectedPayTo: "0x2222222222222222222222222222222222222222" },
  parity: { ok: true, why: "same document" },
  nonceUsed: false,
  simulation: { state: "ok" },
} satisfies Facts;

/** The row with this id, failing the test when the table has none. */
const rowFor = (rows: CheckRow[], id: string): CheckRow => present(findRow(rows, id), `the ${id} row`);
const findRow = (rows: CheckRow[], id: string): CheckRow | undefined => rows.find((r) => r.id === id);

test("a sound quote blocks nothing", () => {
  const rows = preflight(FACTS);
  assert.deepEqual(
    blockers(rows).map((r) => r.id),
    [],
  );
  assert.deepEqual(
    unchecked(rows).map((r) => r.id),
    [],
  );
});

test("a recipient you did not pin is unchecked, never a pass", () => {
  const rows = preflight({ ...FACTS, guards: { ...FACTS.guards, expectedPayTo: "" } });
  assert.equal(rowFor(rows, "payTo").state, "unchecked");
  assert.match(rowFor(rows, "payTo").why, /no way back/);
});

test("a recipient that is not the one you pinned blocks", () => {
  const rows = preflight({
    ...FACTS,
    requirement: { ...REQUIREMENT, payTo: "0x4444444444444444444444444444444444444444" },
  });
  assert.equal(rowFor(rows, "payTo").state, "fail");
  assert.equal(blockers(rows).length, 1);
});

test("an amount over the ceiling blocks, and the comparison is exact", () => {
  const rows = preflight({ ...FACTS, guards: { ...FACTS.guards, maxSpend: "1.49" } });
  assert.equal(rowFor(rows, "amount").state, "fail");
  // One atomic unit under the ceiling passes: the comparison is in atomic units, not in floats.
  const under = preflight({ ...FACTS, guards: { ...FACTS.guards, maxSpend: "1.50" } });
  assert.equal(rowFor(under, "amount").state, "ok");
});

test("an amount that arrived as a JSON number blocks", () => {
  const rows = preflight({ ...FACTS, requirement: { ...REQUIREMENT, amount: malformed<string>(1500000) } });
  assert.equal(rowFor(rows, "amount").state, "fail");
  assert.match(rowFor(rows, "amount").why, /atomic units/);
});

test("a domain the token does not report blocks, whatever the strings say", () => {
  // The quote names "USDC" where the token's separator is built from "USD Coin": the signature
  // would be well formed and refused, with nothing in the error to say why.
  const rows = preflight({ ...FACTS, requirement: { ...REQUIREMENT, extra: { name: "USDC", version: "2" } } });
  assert.equal(rowFor(rows, "domain").state, "fail");
});

test("with no separator to compare against, the token's own name is the fallback", () => {
  const token: TokenReadings = { decimals: 6, name: "USD Coin", version: "2" };
  assert.equal(rowFor(preflight({ ...FACTS, token }), "domain").state, "ok");
  assert.equal(
    rowFor(
      preflight({ ...FACTS, token, requirement: { ...REQUIREMENT, extra: { name: "USDC", version: "2" } } }),
      "domain",
    ).state,
    "fail",
  );
});

test("a wallet on the wrong chain blocks", () => {
  const rows = preflight({ ...FACTS, wallet: { ...FACTS.wallet, chainId: 1 } });
  assert.equal(rowFor(rows, "wallet").state, "fail");
});

test("a spent nonce and a failing simulation both block", () => {
  assert.equal(rowFor(preflight({ ...FACTS, nonceUsed: true }), "nonce").state, "fail");
  assert.equal(
    rowFor(preflight({ ...FACTS, simulation: { state: "fail", detail: "reverted" } }), "simulation").state,
    "fail",
  );
});

test("a balance that does not cover the amount blocks before the wallet is opened", () => {
  const rows = preflight({ ...FACTS, wallet: { ...FACTS.wallet, balanceAtomic: "1000" } });
  assert.equal(rowFor(rows, "balance").state, "fail");
});

test("the Solana rail is checked as far as it can be read offline", () => {
  const rows = preflight({
    ...FACTS,
    requirement: {
      scheme: "exact",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "1500000",
      payTo: "8kPbdgFtnA1SNfhGjLJ8fXrVxEoH3Qz1XBuTXbWZfake",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      maxTimeoutSeconds: 300,
      extra: { feePayer: "FeePayer11111111111111111111111111111111111" },
    },
    token: { decimals: 6, symbol: "USDC" },
    guards: { maxSpend: "5.00", expectedPayTo: "" },
  });
  assert.equal(rowFor(rows, "feePayer").state, "ok");
  assert.equal(rowFor(rows, "payTo").state, "unchecked");
  // Nothing EVM-only leaks into the Solana table.
  assert.equal(findRow(rows, "domain"), undefined);
  // And the spend ceiling is the same ceiling. $1.50 is under $5.00.
  assert.equal(rowFor(rows, "amount").state, "ok");
});

test("the recipient is checked against what this tool ships knowing, not against your memory", () => {
  // "Why should the user define payTo?" They should not. The row exists to notice the address
  // CHANGING, and a tool that ships with a source ships with the address that source has always
  // paid to, so it can do that itself. Typing one in is for a source this tool does not know.
  const quote = (payTo: string, extra: Partial<Facts> = {}) =>
    preflight({
      ...FACTS,
      ...extra,
      requirement: { ...REQUIREMENT, payTo },
      guards: { maxSpend: "5.00", expectedPayTo: "" },
    });

  const known = "0x2169FcD1a1D527Bf6a9031D898fAbDa01Bfd9D41";
  const good = quote(known, { knownPayTo: known });
  assert.equal(rowFor(good, "payTo").state, "ok", "the preset's own address was not recognised");
  assert.match(rowFor(good, "payTo").why, /always paid to/);

  // The case the row is for: the endpoint names somebody else. Nobody had to type anything.
  const moved = quote("0x1111111111111111111111111111111111111111", { knownPayTo: known });
  assert.equal(rowFor(moved, "payTo").state, "fail");
  assert.match(rowFor(moved, "payTo").why, /known to pay to/);
  assert.match(rowFor(moved, "payTo").fix ?? "", /Do not pay/);

  // A source this tool does not ship with still asks, because there is nothing to compare against.
  assert.equal(rowFor(quote(known), "payTo").state, "unchecked");

  // And a hand-pinned address still wins over the preset, for somebody holding a quote to an
  // address of their own choosing.
  const pinnedElsewhere = preflight({
    ...FACTS,
    knownPayTo: known,
    requirement: { ...REQUIREMENT, payTo: known },
    guards: { maxSpend: "5.00", expectedPayTo: "0x1111111111111111111111111111111111111111" },
  });
  assert.equal(rowFor(pinnedElsewhere, "payTo").state, "fail");
  assert.match(rowFor(pinnedElsewhere, "payTo").why, /you pinned/);
});

test("the Solana recipient is checked the same way, and base58 is case sensitive", () => {
  const solana = (payTo: string, knownPayTo: string) =>
    preflight({
      ...FACTS,
      knownPayTo,
      token: { decimals: 6, symbol: "USDC" },
      requirement: {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        amount: "1000000",
        payTo,
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        maxTimeoutSeconds: 300,
        extra: { feePayer: "FeePayer11111111111111111111111111111111111" },
      },
      guards: { maxSpend: "5.00", expectedPayTo: "" },
    });

  const known = "HiFZ2Q7BgmYDC6YqpigYQa5GAa2Sa2VZeozF6hYZxPCv";
  assert.equal(rowFor(solana(known, known), "payTo").state, "ok");
  assert.equal(rowFor(solana("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", known), "payTo").state, "fail");
  // Lowercasing it would be a different address on this chain, and comparing that way would let a
  // lookalike through. An EVM address is hex and case-insensitive; this one is not.
  assert.equal(rowFor(solana(known.toLowerCase(), known), "payTo").state, "fail");
  assert.equal(rowFor(solana(known, ""), "payTo").state, "unchecked");
});

test("a Solana quote whose unit nobody can establish is refused", () => {
  // The endpoint chooses the mint and the decimals live in an account this rail cannot read, so an
  // unknown mint leaves the amount a bare integer. A ceiling compared against the wrong unit is not
  // a ceiling: "900000" is ninety cents of USDC and nine hundred thousand whole tokens of a mint
  // with no decimals, and the second one passes a one dollar limit.
  const quote = (asset: string, extra: RequirementExtra, token: TokenReadings) =>
    preflight({
      ...FACTS,
      token,
      requirement: {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        amount: "900000",
        payTo: "HiFZ2Q7BgmYDC6YqpigYQa5GAa2Sa2VZeozF6hYZxPCv",
        asset,
        maxTimeoutSeconds: 300,
        extra: { feePayer: "FeePayer11111111111111111111111111111111111", ...extra },
      },
      guards: { maxSpend: "1.00", expectedPayTo: "HiFZ2Q7BgmYDC6YqpigYQa5GAa2Sa2VZeozF6hYZxPCv" },
    });

  // A mint nobody could size: refused, and the refusal names what would fix it.
  const unknown = quote("So11111111111111111111111111111111111111112", {}, {});
  assert.equal(rowFor(unknown, "decimals").state, "fail");
  assert.match(rowFor(unknown, "decimals").fix ?? "", /publish `decimals`/);
  assert.ok(
    blockers(unknown).some((r) => r.id === "decimals"),
    "the unknown unit does not block signing",
  );

  // USDC, which this tool knows: ninety cents, under the ceiling, and it goes through. The row only
  // exists when there is something wrong with the unit, so a known one leaves no row at all.
  const known = quote("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", {}, { decimals: 6, symbol: "USDC" });
  assert.equal(findRow(known, "decimals"), undefined);
  assert.equal(rowFor(known, "amount").state, "ok");
  assert.equal(blockers(known).length, 0);

  // And the same quote with the unit published by the endpoint rather than known here.
  const published = quote("So11111111111111111111111111111111111111112", { decimals: 6 }, { decimals: 6, symbol: "" });
  assert.equal(blockers(published).length, 0, "a published unit did not clear the refusal");
});

test("your spend ceiling is a ceiling on the Solana rail too", () => {
  // It was not, and it did not matter while this lab could only look at a Solana quote. The moment
  // it could pay one, a rail that read the one number you set by hand as decoration would be worse
  // than a rail that never offered.
  const solana = (amount: string, guards: Limits) =>
    preflight({
      ...FACTS,
      token: { decimals: 6, symbol: "USDC" },
      requirement: {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        amount,
        payTo: "HiFZ2Q7BgmYDC6YqpigYQa5GAa2Sa2VZeozF6hYZxPCv",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        maxTimeoutSeconds: 300,
        extra: { feePayer: "FeePayer11111111111111111111111111111111111" },
      },
      guards,
    });

  const over = solana("9000000", { maxSpend: "5.00", expectedPayTo: "" });
  assert.equal(rowFor(over, "amount").state, "fail", "$9 was accepted under a $5 ceiling");
  assert.match(rowFor(over, "amount").why, /over your ceiling/);

  // A quote that names somebody other than the address you pinned is refused here as it is on the
  // other rail: base58 is case sensitive and has exactly one spelling, so this is a string compare.
  const wrong = solana("1000000", { maxSpend: "5.00", expectedPayTo: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9" });
  assert.equal(rowFor(wrong, "payTo").state, "fail", "a recipient nobody pinned was accepted");

  const fine = solana("1000000", { maxSpend: "5.00", expectedPayTo: "HiFZ2Q7BgmYDC6YqpigYQa5GAa2Sa2VZeozF6hYZxPCv" });
  assert.equal(rowFor(fine, "amount").state, "ok");
  assert.equal(rowFor(fine, "payTo").state, "ok");
  assert.equal(blockers(fine).length, 0, "a good Solana quote is blocked by something");
});

test("money is read and compared as strings, never as floats", () => {
  assert.equal(atomicToDecimal("1500000", 6), "1.5");
  assert.equal(formatUsd("1500000", 6), "1.50");
  assert.equal(formatUsd("1", 6), "0.000001");
  assert.equal(atomicToDecimal("123456789012345678901234567890", 18), "123456789012.34567890123456789");
  assert.equal(decimalToAtomic("5.00", 6), 5000000n);
  // More precision than the token has would quietly RAISE a ceiling if it were truncated.
  assert.equal(decimalToAtomic("5.0000001", 6), null);
});

test("a header that disagrees with the body is a blocker, not a note", () => {
  const body = { x402Version: 2, accepts: [REQUIREMENT] };
  const drifted = { x402Version: 2, accepts: [{ ...REQUIREMENT, amount: "9900000" }] };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

  const same = parseQuote({ status: 402, body: JSON.stringify(body), headers: { "payment-required": encode(body) } });
  assert.equal(same.parity?.ok, true);
  // Key order is not significance: a reordered copy is the same document.
  const reordered = parseQuote({
    status: 402,
    body: JSON.stringify(body),
    headers: { "payment-required": encode({ accepts: [REQUIREMENT], x402Version: 2 }) },
  });
  assert.equal(reordered.parity?.ok, true);

  const mismatch = parseQuote({
    status: 402,
    body: JSON.stringify(body),
    headers: { "payment-required": encode(drifted) },
  });
  assert.equal(mismatch.parity?.ok, false);
  assert.equal(rowFor(preflight({ ...FACTS, parity: mismatch.parity }), "parity").state, "fail");
});

test("a short on-chain balance does not advise a top-up when the endpoint holds money for you", () => {
  // The row somebody actually stares at when they cannot pay. "Top up this wallet, or choose
  // something cheaper" is right for a resource that only takes chain payments and wrong for one
  // that is already holding a balance: it sends them to buy USDC they do not need.
  const base = { ...FACTS, wallet: { ...FACTS.wallet, balanceAtomic: "281874" } };
  const rowOf = (facts: Facts): CheckRow =>
    present(
      preflight(facts).find((row) => row.label === "wallet balance"),
      "the wallet balance row",
    );

  const plain = rowOf(base);
  assert.equal(plain.state, "fail");
  assert.match(plain.fix ?? "", /Top up this wallet/);

  const known = rowOf({ ...base, endpoint: { spendableBalance: true, balanceUSD: 5.709225 } });
  // The on-chain check still fails, because it is a true statement about a different balance.
  assert.equal(known.state, "fail");
  assert.match(known.fix ?? "", /5\.709225 on this endpoint/);
  assert.doesNotMatch(known.fix ?? "", /Top up/);

  const maybe = rowOf({ ...base, endpoint: { spendableBalance: true, balanceUSD: null } });
  assert.match(maybe.fix ?? "", /may be holding a balance/);
});
