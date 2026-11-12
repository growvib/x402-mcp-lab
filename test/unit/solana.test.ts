// The Solana payment, built by hand.
//
// Everything here is the kind of code that is either exactly right or silently wrong: a base58
// digit, a curve check, an account index, a length prefix. None of it fails loudly on its own, and
// all of it ends in a transaction somebody signs with money.
//
// So the two things that would otherwise be assumptions are checked against something outside this
// file: the associated-token-account derivation against a real mainnet account, and the assembled
// bytes against the server's own Go parser (wireshape/wire_shape_test.go, fed by the fixture
// wireshape/generate.mjs writes from this same code).

import assert from "node:assert/strict";
import test from "node:test";

import { decodeBase58, encodeBase58, isBase58Address } from "../../src/lib/base58.ts";
import {
  ATA_PROGRAM,
  assembleTransaction,
  associatedTokenAddress,
  buildPaymentMessage,
  COMPUTE_BUDGET_PROGRAM,
  compactU16,
  isOnCurve,
  KNOWN_MINTS,
  MEMO_PROGRAM,
  mintUnit,
  type PaymentMessageInput,
  SYSTEM_PROGRAM,
  signedByPayer,
  solanaExtra,
  TOKEN_PROGRAM,
  toBase64,
  unsignedTransaction,
} from "../../src/lib/solana.ts";
import type { RequirementExtra } from "../../src/lib/x402.ts";
import { malformed, present } from "./support.ts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FEE_PAYER = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const BLOCKHASH = "GeU1ssVJ4Tp6meoGMigV6LFcWDApgZyvwpa2SZLvfd6A";
const PAY_TO = "HiFZ2Q7BgmYDC6YqpigYQa5GAa2Sa2VZeozF6hYZxPCv";
const PAYER = "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S";

/** The bytes of a key this file knows is base58. */
const bytesOf = (key: string): Uint8Array => present(decodeBase58(key), `the bytes of ${key}`);

test("base58 round trips a key, and the all-zero one is 32 bytes and not 33", () => {
  for (const key of [USDC, TOKEN_PROGRAM, ATA_PROGRAM, FEE_PAYER, PAYER]) {
    assert.equal(bytesOf(key).length, 32, `${key} is not 32 bytes`);
    assert.equal(encodeBase58(bytesOf(key)), key, `${key} does not survive the round trip`);
  }

  // The System Program id is 32 zero bytes, which base58 writes as 32 ones and nothing else. The
  // first version of this carried a spurious high-order zero through the arithmetic and produced
  // 33 bytes, which parses as a key right up until it shifts every byte after it in a serialized
  // message. The Go cross-check found it; this keeps it found.
  assert.equal(bytesOf(SYSTEM_PROGRAM).length, 32);
  assert.equal(encodeBase58(new Uint8Array(32)), SYSTEM_PROGRAM);
  assert.equal(encodeBase58(decodeBase58(SYSTEM_PROGRAM)), SYSTEM_PROGRAM);

  // A leading zero byte in an otherwise ordinary value is the same rule, one byte in.
  const oneLeadingZero = Uint8Array.from([0, 1, 2, 3]);
  assert.deepEqual(decodeBase58(encodeBase58(oneLeadingZero)), oneLeadingZero);
});

test("base58 refuses what is not base58", () => {
  // The four characters the alphabet leaves out, because they misread by hand.
  for (const bad of ["0", "O", "I", "l", "abc!", " ", ""]) {
    assert.equal(decodeBase58(bad), null, `${JSON.stringify(bad)} decoded as base58`);
  }
  assert.equal(isBase58Address(USDC), true);
  assert.equal(isBase58Address("not an address"), false);
  assert.equal(isBase58Address(encodeBase58(new Uint8Array(31))), false, "31 bytes is not a key");
});

test("the curve check knows a public key from a program address", () => {
  // Every wallet address IS a point on the curve: that is what makes a private key able to sign
  // for it.
  for (const key of [PAYER, PAY_TO, FEE_PAYER, USDC]) {
    assert.equal(isOnCurve(decodeBase58(key)), true, `${key} should be a curve point`);
  }
  // And a derived address is defined by being off it, so that nothing can ever sign for it.
  assert.equal(isOnCurve(decodeBase58("9KaA7vEBUdRCcBWxfuMjxYwKfvu8Us3Cg5gkhVFt2LNk")), false);
  assert.equal(isOnCurve(new Uint8Array(31)), false, "a short value is not a point");
  assert.equal(isOnCurve(null), false);
});

test("the token account is the one the chain has, not the one we hoped for", async () => {
  // Ground truth, not a second opinion: getTokenAccountsByOwner on Solana mainnet returns exactly
  // this account for this owner and this mint. If the derivation (SHA-256, the bump loop and the
  // curve check) were wrong in any part, it would land somewhere else.
  assert.equal(await associatedTokenAddress(PAYER, USDC), "9KaA7vEBUdRCcBWxfuMjxYwKfvu8Us3Cg5gkhVFt2LNk");

  // And the payee's, which does NOT exist on chain yet: nobody has paid GrowVib on Solana, so the
  // transaction has to create it. Derivation does not care whether the account exists, which is
  // the property that makes the idempotent create safe.
  assert.equal(await associatedTokenAddress(PAY_TO, USDC), "FnHrAcDo9wbwG4StfWQM4VPNwv2Ex4K39XVVM1nzyd4c");

  await assert.rejects(() => associatedTokenAddress("not a wallet", USDC), /not a wallet address/);
});

test("compact-u16 is the length prefix Solana reads, at every boundary", () => {
  assert.deepEqual([...compactU16(0)], [0]);
  assert.deepEqual([...compactU16(5)], [5]);
  assert.deepEqual([...compactU16(127)], [127]);
  // Seven bits per byte, low group first, high bit set while more follow.
  assert.deepEqual([...compactU16(128)], [0x80, 0x01]);
  assert.deepEqual([...compactU16(255)], [0xff, 0x01]);
  assert.deepEqual([...compactU16(16384)], [0x80, 0x80, 0x01]);
  assert.throws(() => compactU16(-1));
  assert.throws(() => compactU16(70000));
});

test("the message names the accounts in the order the format fixes", async () => {
  const { message, keys, source, destination, checked } = await buildPaymentMessage({
    payer: PAYER,
    payTo: PAY_TO,
    mint: USDC,
    amountAtomic: "1500000",
    feePayer: FEE_PAYER,
    recentBlockhash: BLOCKHASH,
  });

  // Signers first, fee payer at index zero, because that is how Solana decides who pays the fee.
  assert.equal(keys[0], FEE_PAYER);
  assert.equal(keys[1], PAYER);
  assert.equal(keys[2], source);
  assert.equal(keys[3], destination);
  assert.equal(checked, true, "USDC's decimals are known, so the checked form is the one to send");

  // The header: two signers, of which one is read-only (the payer authorizes, it is not written
  // to), and four read-only non-signers (the mint and three programs).
  assert.deepEqual([...message.slice(0, 3)], [2, 1, 4]);
  assert.deepEqual([...message.slice(3, 4)], [keys.length]);
  assert.deepEqual(keys.slice(4), [USDC, COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM, MEMO_PROGRAM]);

  // Length, to the byte. Header, key count, keys, blockhash, instruction count, then the four
  // instructions: compute limit (u8 + u32), compute price (u8 + u64), TransferChecked, and a 32
  // character memo. A message one byte out is a transaction that does not parse, which is exactly
  // how the all-zero base58 bug showed up.
  const expected =
    3 +
    1 +
    keys.length * 32 +
    32 +
    1 +
    (1 + 1 + 0 + 1 + 5) +
    (1 + 1 + 0 + 1 + 9) +
    (1 + 1 + 4 + 1 + 10) +
    (1 + 1 + 0 + 1 + 32);
  assert.equal(message.length, expected);
});

// The instructions of a message this file built, read back by walking the format. Just enough of a
// parser to answer "which programs run, on which accounts, with what data".
interface Instruction {
  program: string;
  accounts: string[];
  data: Uint8Array;
}

function instructionsOf(message: Uint8Array): Instruction[] {
  const byte = (index: number): number => present(message[index], `byte ${index} of the message`);
  const key = (keys: string[], index: number): string => present(keys[index], `account ${index}`);
  let at = 3;
  const keyCount = byte(at);
  at += 1;
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i += 1, at += 32) keys.push(encodeBase58(message.slice(at, at + 32)));
  at += 32; // blockhash
  const count = byte(at);
  at += 1;
  const out: Instruction[] = [];
  for (let i = 0; i < count; i += 1) {
    const program = key(keys, byte(at));
    const accounts = [...message.slice(at + 2, at + 2 + byte(at + 1))].map((index) => key(keys, index));
    at += 2 + accounts.length;
    const size = byte(at);
    const data = message.slice(at + 1, at + 1 + size);
    at += 1 + size;
    out.push({ program, accounts, data });
  }
  return out;
}

/** The nth instruction's data, failing the test when there are fewer. */
const dataOf = (instructions: Instruction[], index: number): Uint8Array =>
  present(instructions[index], `instruction ${index}`).data;

test("the transaction has the layout the facilitator verifies and nothing else", async () => {
  // x402 exact SVM, "instruction layout" and "fee payer safety". The first version put an
  // idempotent create of the recipient's token account first, funded by the fee payer, carried no
  // compute budget and no memo, and the facilitator refused every Solana payment at verify.
  const { message, memo } = await buildPaymentMessage({
    payer: PAYER,
    payTo: PAY_TO,
    mint: USDC,
    amountAtomic: "1500000",
    feePayer: FEE_PAYER,
    recentBlockhash: BLOCKHASH,
  });
  const instructions = instructionsOf(message);
  assert.deepEqual(
    instructions.map((ins) => ins.program),
    [COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM, MEMO_PROGRAM],
  );
  assert.deepEqual([...dataOf(instructions, 0)], [2, 0x20, 0x4e, 0, 0], "compute unit limit is not 20,000");
  assert.deepEqual(
    [...dataOf(instructions, 1)],
    [3, 1, 0, 0, 0, 0, 0, 0, 0],
    "compute unit price is not 1 micro-lamport",
  );
  assert.equal(dataOf(instructions, 2)[0], 12, "the transfer is not TransferChecked");
  for (const [index, ins] of instructions.entries()) {
    assert.ok(!ins.accounts.includes(FEE_PAYER), `instruction ${index} names the fee payer`);
  }

  // No seller memo: a random 16 byte nonce, hex, different every time.
  assert.match(memo, /^[0-9a-f]{32}$/);
  assert.equal(new TextDecoder().decode(dataOf(instructions, 3)), memo);
  const again = await buildPaymentMessage({
    payer: PAYER,
    payTo: PAY_TO,
    mint: USDC,
    amountAtomic: "1500000",
    feePayer: FEE_PAYER,
    recentBlockhash: BLOCKHASH,
  });
  assert.notEqual(again.memo, memo, "two payments with the same parameters built the same transaction");
});

test("a seller's memo is carried verbatim, and one over the limit is refused", async () => {
  const base: PaymentMessageInput = {
    payer: PAYER,
    payTo: PAY_TO,
    mint: USDC,
    amountAtomic: "1500000",
    feePayer: FEE_PAYER,
    recentBlockhash: BLOCKHASH,
  };
  const { message, memo } = await buildPaymentMessage({ ...base, memo: "pi_3abc123def456" });
  assert.equal(memo, "pi_3abc123def456");
  assert.equal(new TextDecoder().decode(dataOf(instructionsOf(message), 3)), "pi_3abc123def456");
  await assert.rejects(() => buildPaymentMessage({ ...base, memo: "x".repeat(257) }), /over the 256/);
  assert.equal(
    solanaExtra({ extra: { feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH, memo: "inv-7" } }).memo,
    "inv-7",
  );
});

test("a mint whose unit is unknown is refused, not sent in a guessed one", async () => {
  // TransferChecked carries the mint's decimals, and the decimals live in an account this rail
  // cannot read. The first version fell back to the unchecked Transfer, which carries no decimals
  // byte: that sent an amount whose unit nothing on the page and nothing on chain had established.
  // The amount in a quote is atomic, so "900000" is ninety cents of USDC and nine hundred thousand
  // whole tokens of a mint with none, and the endpoint is the one choosing the mint.
  await assert.rejects(
    () =>
      buildPaymentMessage({
        payer: PAYER,
        payTo: PAY_TO,
        mint: "So11111111111111111111111111111111111111112",
        amountAtomic: "1000",
        feePayer: FEE_PAYER,
        recentBlockhash: BLOCKHASH,
      }),
    /decimals of .* are not known/,
  );

  // An endpoint that publishes them, or a mint this tool knows, is fine and gets the checked form.
  const told = await buildPaymentMessage({
    payer: PAYER,
    payTo: PAY_TO,
    mint: "So11111111111111111111111111111111111111112",
    amountAtomic: "1000",
    feePayer: FEE_PAYER,
    recentBlockhash: BLOCKHASH,
    decimals: 9,
  });
  assert.equal(told.checked, true);
});

test("the unit of a quote comes from the table or the quote, and otherwise from nowhere", () => {
  assert.deepEqual(mintUnit(USDC, {}), { symbol: "USDC", decimals: 6 });
  // What the endpoint publishes is used, and named as published rather than as a symbol we know.
  assert.deepEqual(mintUnit("So11111111111111111111111111111111111111112", { decimals: 9 }), {
    symbol: "",
    decimals: 9,
  });
  assert.equal(mintUnit("So11111111111111111111111111111111111111112", {}), null);
  // The digits of a number count, since this family of APIs writes integers as strings right beside
  // this field. Anything looser does not: Number("") is 0, and so is Number(null) and Number([]),
  // and "zero decimals" is exactly the answer that turns a ninety cent ceiling into nine hundred
  // thousand whole tokens.
  const extraWith = (decimals: unknown) => malformed<RequirementExtra>({ decimals });
  assert.deepEqual(mintUnit("So11111111111111111111111111111111111111112", extraWith("9")), {
    symbol: "",
    decimals: 9,
  });
  for (const bad of ["", "  ", "9.0", "0x6", null, [], {}, true, 1.5, -1, 99, Number.NaN]) {
    assert.equal(
      mintUnit("So11111111111111111111111111111111111111112", extraWith(bad)),
      null,
      `${JSON.stringify(bad)} was read as a decimals count`,
    );
  }
  assert.equal(mintUnit(USDC, malformed<RequirementExtra>(null)), KNOWN_MINTS[USDC]);
});

test("the message refuses inputs that are not addresses", async () => {
  const good: PaymentMessageInput = {
    payer: PAYER,
    payTo: PAY_TO,
    mint: USDC,
    amountAtomic: "1500000",
    feePayer: FEE_PAYER,
    recentBlockhash: BLOCKHASH,
  };
  for (const field of ["payer", "payTo", "mint", "feePayer", "recentBlockhash"] as const) {
    await assert.rejects(
      () => buildPaymentMessage({ ...good, [field]: "nonsense" }),
      new RegExp(`${field} is not a Solana address`),
      `${field} was accepted as nonsense`,
    );
  }
  // A wallet that is somehow the facilitator's fee payer would collapse the two signature slots
  // into one, and the server would find no paying wallet at all.
  await assert.rejects(() => buildPaymentMessage({ ...good, payer: FEE_PAYER }), /cannot also be/);
  // An amount that does not fit the token program's u64.
  await assert.rejects(() => buildPaymentMessage({ ...good, amountAtomic: "18446744073709551616" }), /64 bits/);
});

test("the assembled transaction leaves the facilitator's signature slot empty", async () => {
  const { message } = await buildPaymentMessage({
    payer: PAYER,
    payTo: PAY_TO,
    mint: USDC,
    amountAtomic: "1500000",
    feePayer: FEE_PAYER,
    recentBlockhash: BLOCKHASH,
  });
  const signature = encodeBase58(new Uint8Array(64).fill(7));
  const raw = assembleTransaction({ message, payerSignature: signature });

  assert.equal(raw[0], 2, "the signature count is not the compact-u16 two");
  assert.deepEqual(
    [...raw.slice(1, 65)],
    new Array(64).fill(0),
    "the fee payer's slot is not empty, so the facilitator has nowhere to sign",
  );
  assert.deepEqual([...raw.slice(65, 129)], new Array(64).fill(7));
  assert.deepEqual([...raw.slice(129)], [...message]);
  assert.equal(raw.length, 1 + 64 + 64 + message.length);

  // And it is base64 the server can read back.
  assert.match(toBase64(raw), /^[A-Za-z0-9+/]+=*$/);

  assert.throws(() => assembleTransaction({ message, payerSignature: "short" }), /64 byte signature/);
});

test("what comes back from the wallet is checked against what went in", async () => {
  const { message } = await buildPaymentMessage({
    payer: PAYER,
    payTo: PAY_TO,
    mint: USDC,
    amountAtomic: "1500000",
    feePayer: FEE_PAYER,
    recentBlockhash: BLOCKHASH,
  });
  const unsigned = unsignedTransaction(message);
  assert.equal(unsigned.length, 1 + 64 + 64 + message.length);
  assert.deepEqual([...unsigned.slice(1, 129)], new Array(128).fill(0), "a slot went out already filled");

  const sign = (mutate?: (bytes: Uint8Array) => void): Uint8Array => {
    const signed = Uint8Array.from(unsigned);
    signed.fill(9, 65, 129);
    if (mutate) mutate(signed);
    return signed;
  };

  assert.equal(signedByPayer(sign(), message), null, "a correctly signed transaction was refused");

  // The one substitution that matters: same length, same slots, different transfer.
  const refusal = (signed: unknown): string => present(signedByPayer(signed, message), "the refusal");
  const transferByte = 1 + 64 + 64 + 40;
  assert.match(
    refusal(
      sign((b) => {
        b[transferByte] = present(b[transferByte], "the transfer byte") ^ 0xff;
      }),
    ),
    /different transaction/,
  );
  assert.match(refusal(sign((b) => b.fill(0, 65, 129))), /did not sign/);
  assert.match(refusal(sign((b) => b.fill(1, 1, 65))), /fee payer's slot came back filled/);
  assert.match(
    refusal(
      sign((b) => {
        b[0] = 1;
      }),
    ),
    /signature slots/,
  );
  assert.match(refusal(unsigned.slice(0, -1)), /different length/);
  assert.match(refusal("not bytes"), /not transaction bytes/);
});

test("a Solana quote that cannot be paid says which part is missing", () => {
  assert.deepEqual(solanaExtra({ extra: { feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH } }).missing, []);
  assert.deepEqual(solanaExtra({ extra: { feePayer: FEE_PAYER } }).missing, ["recentBlockhash"]);
  assert.deepEqual(solanaExtra({ extra: {} }).missing, ["feePayer", "recentBlockhash"]);
  assert.deepEqual(solanaExtra(null).missing, ["feePayer", "recentBlockhash"]);
});
