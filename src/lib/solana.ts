// Building the payment a Solana x402 quote asks for.
//
// The EVM rail asks for a signature over a typed-data struct and the facilitator turns it into a
// transfer. The Solana rail asks for the transfer itself: a real transaction, already signed by
// the paying wallet, with the FACILITATOR as fee payer so the payer needs no SOL. The facilitator
// adds its own signature and submits. That is the whole difference, and it is why this file exists
// while the EVM side needs only an EIP-712 struct.
//
// Everything needed to build it arrives in the 402, in the requirement's `extra`: the fee payer
// and a recent blockhash. So this is all local arithmetic, and the lab's promise that it fetches
// nothing to do its work survives: no RPC, no node, no library.
//
// Three pieces of Solana are implemented here because a transaction cannot be built without them:
// base58 (in base58.ts), the associated-token-account derivation (which needs SHA-256 and an
// ed25519 curve check), and the legacy message wire format.

import { decodeBase58, encodeBase58 } from "./base58.ts";
import type { PaymentRequirement, RequirementExtra } from "./x402.ts";

// The program ids this builds against, base58, as the chain knows them.
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/** The SPL token instruction discriminator. Only the checked form: see KNOWN_MINTS. */
const TRANSFER_CHECKED = 12;
// Compute budget discriminators and the values the x402 reference client sends. The facilitator
// checks both instructions are there, in this order, and caps the price (5 lamports per unit in the
// reference implementation), so these are the reference's numbers rather than a tuning of our own.
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
const COMPUTE_UNIT_LIMIT = 20_000;
const COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1;
/** The spec caps a seller's memo at 256 bytes. */
const MAX_MEMO_BYTES = 256;

export interface MintUnit {
  symbol: string;
  decimals: number;
}

/**
 * Mints this tool can name and size without asking a chain.
 *
 * Decimals live in the mint account, which cannot be read without an RPC, and they are not a
 * detail: they are the unit of every number on the screen. The amount in a quote is atomic, so the
 * same "900000" is ninety cents of USDC or nine hundred thousand whole tokens of a mint with none,
 * and a spend ceiling compared against the wrong unit is not a ceiling. So an unknown mint is
 * REFUSED rather than guessed at (see the decimals check in checks.ts), and every payment carries
 * TransferChecked's decimals byte so the token program enforces the unit as well.
 */
export const KNOWN_MINTS: Readonly<Record<string, MintUnit>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6 },
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": { symbol: "USDC", decimals: 6 }, // devnet
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", decimals: 6 },
};

/**
 * What the page knows about the unit of a Solana quote's amount: this tool's own table first, then
 * whatever the endpoint published beside the quote. Null when neither answers, which is a refusal
 * rather than a default.
 */
export function mintUnit(mint: string | undefined, extra: RequirementExtra | undefined): MintUnit | null {
  const known = mint ? KNOWN_MINTS[mint] : undefined;
  if (known) return known;
  // A number, or the digits of one: this family of APIs writes integers as strings beside this very
  // field (`lastValidBlockHeight` is one). Parsed narrowly on purpose, because Number("") is 0 and
  // so is Number(null), and "zero decimals" is precisely the answer that turns a ninety cent
  // ceiling into nine hundred thousand whole tokens.
  const raw: unknown = extra?.decimals;
  const published =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN;
  if (Number.isInteger(published) && published >= 0 && published <= 18) {
    return { symbol: "", decimals: published };
  }
  return null;
}

// ---------------------------------------------------------------------------
// ed25519, just enough to answer "is this 32 bytes a point on the curve?"
//
// A program-derived address is BY DEFINITION a 32-byte value that is NOT a valid public key, so
// that no private key can ever sign for it. Deriving one means hashing until the answer falls off
// the curve, which cannot be done without being able to ask.
// ---------------------------------------------------------------------------

const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function modP(value: bigint): bigint {
  const out = value % P;
  return out < 0n ? out + P : out;
}

function powP(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = modP(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = modP(result * b);
    b = modP(b * b);
    e >>= 1n;
  }
  return result;
}

/**
 * isOnCurve decompresses the point the way ed25519 does and reports whether it decompresses at
 * all. The curve is -x^2 + y^2 = 1 + d*x^2*y^2, so x^2 = (y^2 - 1) / (d*y^2 + 1), and a y for
 * which that has no square root is not a point.
 */
export function isOnCurve(bytes: Uint8Array | null | undefined): boolean {
  if (bytes?.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) y = (y << 8n) | BigInt(bytes[i] ?? 0);
  const sign = (y >> 255n) & 1n;
  y &= (1n << 255n) - 1n;
  // The spec requires the canonical representative: a y at or above the field order is not a point.
  if (y >= P) return false;

  const y2 = modP(y * y);
  const u = modP(y2 - 1n);
  const v = modP(D * y2 + 1n);
  if (v === 0n) return false;

  // The standard square root for p = 5 (mod 8): x = u*v^3 * (u*v^7)^((p-5)/8).
  const v3 = modP(v * modP(v * v));
  const v7 = modP(v3 * modP(v3 * v));
  let x = modP(modP(u * v3) * powP(modP(u * v7), (P - 5n) / 8n));

  const check = modP(v * modP(x * x));
  if (check === modP(-u)) {
    // Off by the square root of -1, which is a root of the other sign.
    x = modP(x * powP(2n, (P - 1n) / 4n));
  } else if (check !== u) {
    return false;
  }
  // x = 0 with the sign bit set is the one encoding with no point behind it.
  return !(x === 0n && sign === 1n);
}

// ---------------------------------------------------------------------------
// Program-derived addresses
// ---------------------------------------------------------------------------

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export function concatBytes(...parts: ArrayLike<number>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function key32(value: unknown, what: string): Uint8Array {
  const raw = decodeBase58(value);
  if (raw?.length !== 32) throw new Error(`not ${what}: ${String(value ?? "(missing)")}`);
  return raw;
}

/**
 * The chain's own derivation: hash the seeds with a bump byte until the result is off the curve,
 * counting the bump down from 255 so every caller finds the same one.
 */
export async function findProgramAddress(
  seeds: readonly Uint8Array[],
  programId: string,
): Promise<{ address: string; bump: number }> {
  const program = key32(programId, "a program id");
  for (let bump = 255; bump >= 0; bump -= 1) {
    const candidate = await sha256(concatBytes(...seeds, Uint8Array.of(bump), program, PDA_MARKER));
    if (!isOnCurve(candidate)) return { address: encodeBase58(candidate), bump };
  }
  // 256 misses in a row has never happened and would mean the hash is not a hash.
  throw new Error("no program address could be derived");
}

/**
 * Where an owner's balance of a mint lives: one deterministic account per (owner, mint), derived
 * from the two keys and the token program.
 */
export async function associatedTokenAddress(owner: string, mint: string): Promise<string> {
  const ownerKey = key32(owner, "a wallet address");
  const mintKey = key32(mint, "a mint address");
  const { address } = await findProgramAddress([ownerKey, key32(TOKEN_PROGRAM, "a program id"), mintKey], ATA_PROGRAM);
  return address;
}

// ---------------------------------------------------------------------------
// The wire format
// ---------------------------------------------------------------------------

/**
 * Solana's short vector length: seven bits per byte, low group first, high bit set while more
 * follow. Every array in a message is prefixed with one.
 */
export function compactU16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`not a compact-u16: ${value}`);
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  out.push(rest);
  return Uint8Array.from(out);
}

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64le(value: bigint | number | string): Uint8Array {
  const out = new Uint8Array(8);
  let rest = BigInt(value);
  if (rest < 0n) throw new Error("a token amount cannot be negative");
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  if (rest !== 0n) throw new Error("a token amount must fit in 64 bits");
  return out;
}

interface Instruction {
  programIdIndex: number;
  accountIndexes: number[];
  data: Uint8Array;
}

function encodeInstruction({ programIdIndex, accountIndexes, data }: Instruction): Uint8Array {
  return concatBytes(
    Uint8Array.of(programIdIndex),
    compactU16(accountIndexes.length),
    Uint8Array.from(accountIndexes),
    compactU16(data.length),
    data,
  );
}

export interface PaymentMessageInput {
  payer: string;
  payTo: string;
  mint: string;
  amountAtomic: bigint | number | string;
  feePayer: string;
  recentBlockhash: string;
  decimals?: number | null;
  memo?: string;
}

export interface PaymentMessage {
  message: Uint8Array;
  keys: string[];
  source: string;
  destination: string;
  memo: string;
  checked: boolean;
}

/**
 * buildPaymentMessage assembles the legacy message the paying wallet signs.
 *
 * The account list has one order and it is not a convention, it is the format: every signer first
 * (writable ones, then read-only ones), then the writable non-signers, then the read-only ones.
 * The header counts say where the boundaries are, and an index into this list is how every
 * instruction names an account. Getting the order wrong produces a transaction that parses and
 * does the wrong thing, which is why the test for this reads the bytes back with an independent
 * parser rather than with this file's assumptions.
 */
export async function buildPaymentMessage({
  payer,
  payTo,
  mint,
  amountAtomic,
  feePayer,
  recentBlockhash,
  decimals,
  memo,
}: PaymentMessageInput): Promise<PaymentMessage> {
  for (const [name, value] of Object.entries({ payer, payTo, mint, feePayer, recentBlockhash })) {
    const raw = decodeBase58(value);
    if (raw?.length !== 32) throw new Error(`${name} is not a Solana address: ${value || "(missing)"}`);
  }
  if (payer === feePayer) throw new Error("the paying wallet cannot also be the facilitator's fee payer");

  const source = await associatedTokenAddress(payer, mint);
  const destination = await associatedTokenAddress(payTo, mint);

  // Index order is the format's order. Named rather than numbered at the call sites below, because
  // an off-by-one here is a transfer from the wrong account.
  //
  // The fee payer is account zero and in NO instruction. That is a facilitator rule, not a style
  // choice (x402 exact SVM, "fee payer safety"): an account the facilitator signs for that also
  // appears in an instruction is an account a client could spend.
  const keys = [feePayer, payer, source, destination, mint, COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM, MEMO_PROGRAM];
  const at = (key: string) => keys.indexOf(key);
  const header = Uint8Array.of(
    2, // fee payer and payer both sign
    1, // of those, the payer is read-only: it authorizes the transfer, it is not written to
    4, // the mint and the three programs are read-only non-signers
  );

  // No fallback to the unchecked Transfer. It carries no decimals byte, which means nothing on
  // chain would catch a unit this page got wrong, and the page has no business sending an amount
  // whose unit it could not establish.
  const known = decimals ?? KNOWN_MINTS[mint]?.decimals;
  if (known === undefined || known === null || !Number.isInteger(known)) {
    throw new Error(`the decimals of ${mint} are not known, so the amount has no unit to send it in`);
  }

  // The memo is what makes two payments with identical parameters two different transactions. The
  // seller's own value when the quote names one (the facilitator then checks it matches), otherwise
  // 16 random bytes, hex so the data is valid UTF-8, which the memo program requires.
  const memoText = memo ? memo : randomHex(16);
  const memoData = new TextEncoder().encode(memoText);
  if (memoData.length > MAX_MEMO_BYTES) {
    throw new Error(`the quote's memo is ${memoData.length} bytes, over the ${MAX_MEMO_BYTES} the scheme allows`);
  }

  // The layout the facilitator verifies, in this order and nothing else: compute unit limit,
  // compute unit price, TransferChecked, memo. The recipient's token account has to exist already;
  // creating it is not an instruction this scheme lets a payment carry.
  const instructions: Instruction[] = [
    {
      programIdIndex: at(COMPUTE_BUDGET_PROGRAM),
      accountIndexes: [],
      data: concatBytes(Uint8Array.of(SET_COMPUTE_UNIT_LIMIT), u32le(COMPUTE_UNIT_LIMIT)),
    },
    {
      programIdIndex: at(COMPUTE_BUDGET_PROGRAM),
      accountIndexes: [],
      data: concatBytes(Uint8Array.of(SET_COMPUTE_UNIT_PRICE), u64le(COMPUTE_UNIT_PRICE_MICROLAMPORTS)),
    },
    {
      programIdIndex: at(TOKEN_PROGRAM),
      accountIndexes: [at(source), at(mint), at(destination), at(payer)],
      data: concatBytes(Uint8Array.of(TRANSFER_CHECKED), u64le(amountAtomic), Uint8Array.of(known)),
    },
    { programIdIndex: at(MEMO_PROGRAM), accountIndexes: [], data: memoData },
  ];

  const message = concatBytes(
    header,
    compactU16(keys.length),
    ...keys.map((key) => key32(key, "an account key")),
    key32(recentBlockhash, "a blockhash"),
    compactU16(instructions.length),
    ...instructions.map(encodeInstruction),
  );

  return { message, keys, source, destination, memo: memoText, checked: true };
}

function randomHex(size: number): string {
  return [...crypto.getRandomValues(new Uint8Array(size))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Where the message starts: one compact-u16 (the count, 2) and two 64 byte signature slots. */
const SIGNATURES = 1 + 64 + 64;

/**
 * The signed message put back together the way the wire wants it: the signature array first, one
 * slot per required signer in account order, then the message.
 *
 * The fee payer's slot is 64 zero bytes. A partially signed transaction is how the x402 Solana
 * scheme works: the facilitator fills its own slot before submitting.
 */
export function assembleTransaction({
  message,
  payerSignature,
}: {
  message: Uint8Array;
  payerSignature: string;
}): Uint8Array {
  const signature = decodeBase58(payerSignature);
  if (signature?.length !== 64) throw new Error("the wallet did not return a 64 byte signature");
  return concatBytes(compactU16(2), new Uint8Array(64), signature, message);
}

/**
 * What goes TO the wallet: the whole transaction with both signature slots empty. A wallet decodes
 * these bytes itself to show what it is about to approve, which is why it gets the transaction
 * rather than the bare message.
 */
export function unsignedTransaction(message: Uint8Array): Uint8Array {
  return concatBytes(compactU16(2), new Uint8Array(64), new Uint8Array(64), message);
}

/**
 * signedByPayer checks what comes back from the wallet before any of it is sent, and returns why it
 * is refused, or null.
 *
 * This is the one place a wallet could substitute something: it is handed bytes, it returns bytes,
 * and nothing but this compares the two. So the message has to be byte for byte the message that
 * went in, the fee payer's slot has to still be empty for the facilitator to sign, and the payer's
 * slot has to have stopped being empty.
 */
export function signedByPayer(signed: unknown, message: Uint8Array): string | null {
  if (!(signed instanceof Uint8Array)) return "the wallet returned something that is not transaction bytes";
  if (signed.length !== SIGNATURES + message.length) return "the wallet returned a transaction of a different length";
  if (signed[0] !== 2) return `the signed transaction carries ${signed[0]} signature slots, not two`;
  const feePayerSlot = signed.subarray(1, 65);
  const payerSlot = signed.subarray(65, SIGNATURES);
  if (!feePayerSlot.every((byte) => byte === 0)) {
    return "the fee payer's slot came back filled, leaving the facilitator nowhere to sign";
  }
  if (payerSlot.every((byte) => byte === 0)) return "the wallet did not sign the transaction";
  for (let i = 0; i < message.length; i += 1) {
    if (signed[SIGNATURES + i] !== message[i]) {
      return "the wallet signed a different transaction from the one it was given";
    }
  }
  return null;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface SolanaExtra {
  feePayer: string;
  recentBlockhash: string;
  memo: string;
  /** The fields a payable Solana requirement must carry and this one does not. */
  missing: string[];
}

/**
 * What the 402 has to carry for any of this to be possible. A Solana requirement without a fee
 * payer is unpayable by anyone, which is worth saying in as many words rather than failing later
 * with an address that is not an address.
 */
export function solanaExtra(requirement: PaymentRequirement | null | undefined): SolanaExtra {
  const extra = requirement?.extra ?? {};
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const feePayer = text(extra.feePayer).trim();
  const recentBlockhash = text(extra.recentBlockhash).trim();
  // A seller's memo is used verbatim, so it is not trimmed: the facilitator compares bytes.
  const memo = text(extra.memo);
  const missing: string[] = [];
  if (!feePayer) missing.push("feePayer");
  if (!recentBlockhash) missing.push("recentBlockhash");
  return { feePayer, recentBlockhash, memo, missing };
}
