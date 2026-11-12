// ABI encoding, EIP-55 addresses, EIP-712 domains and the EIP-3009 authorization.
//
// Everything here is pure and derived: selectors come from keccak rather than from a table, and
// the EIP-712 domain separator is COMPUTED so it can be compared against the one the token itself
// reports. That comparison is the strongest pre-flight check there is, because it answers the only
// question that matters before signing: would this token accept a signature made under the domain
// this quote names? A string comparison of `extra.name` gets that right most of the time; the
// separator gets it right every time.

import { fromHex, keccakHex, selector } from "./keccak.ts";
import type { PaymentRequirement } from "./x402.ts";

export type Hex = `0x${string}`;

export const SELECTORS = {
  decimals: selector("decimals()"),
  name: selector("name()"),
  symbol: selector("symbol()"),
  version: selector("version()"),
  balanceOf: selector("balanceOf(address)"),
  domainSeparator: selector("DOMAIN_SEPARATOR()"),
  authorizationState: selector("authorizationState(address,bytes32)"),
  transferWithAuthorization: selector(
    "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  ),
} as const;

export function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

export function isAddress(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * toChecksumAddress renders EIP-55. Addresses are COMPARED lowercase and DISPLAYED checksummed:
 * one address has two valid spellings, and comparing the displayed form is how a payment goes to
 * an address that looked different from the one you pinned.
 */
export function toChecksumAddress(address: unknown): Hex | null {
  if (!isAddress(address)) return null;
  const lower = address.slice(2).toLowerCase();
  const hash = keccakHex(lower).slice(2);
  let out = "";
  for (let i = 0; i < lower.length; i++) {
    const character = lower.charAt(i);
    out += Number.parseInt(hash.charAt(i), 16) >= 8 ? character.toUpperCase() : character;
  }
  return `0x${out}`;
}

/**
 * hasValidChecksum refuses a mixed-case address whose checksum does not hold, which is what makes
 * a mistyped character an error rather than a payment to nobody.
 */
export function hasValidChecksum(address: unknown): boolean {
  if (!isAddress(address)) return false;
  const body = address.slice(2);
  // An unchecksummed (single-case) address has nothing to verify.
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

export function padLeft(hex: string, bytes = 32): string {
  return hex
    .replace(/^0x/, "")
    .toLowerCase()
    .padStart(bytes * 2, "0");
}

export function encodeAddress(address: unknown): string {
  if (!isAddress(address)) throw new Error(`not an address: ${String(address)}`);
  return padLeft(address.slice(2));
}

export function encodeUint(value: bigint | number | string): string {
  const n = BigInt(value);
  if (n < 0n) throw new Error("negative uint");
  return padLeft(n.toString(16));
}

export function encodeBytes32(hex: string): string {
  const body = hex.replace(/^0x/, "");
  if (body.length !== 64) throw new Error(`not 32 bytes: ${hex}`);
  return body.toLowerCase();
}

export function callData(sel: Hex, ...words: string[]): Hex {
  return `${sel}${words.join("")}`;
}

/**
 * decodeString reads a dynamic string return value: a 32-byte offset, a 32-byte length, then the
 * bytes. Returns null rather than throwing on anything unexpected, because a token that does not
 * implement the call is a fact to report, not a crash.
 */
export function decodeString(hex: unknown): string | null {
  try {
    const body = String(hex).replace(/^0x/, "");
    if (body.length < 128) return null;
    const offset = Number(BigInt(`0x${body.slice(0, 64)}`));
    const lengthAt = offset * 2;
    const length = Number(BigInt(`0x${body.slice(lengthAt, lengthAt + 64)}`));
    const data = body.slice(lengthAt + 64, lengthAt + 64 + length * 2);
    return new TextDecoder().decode(fromHex(data));
  } catch {
    return null;
  }
}

export function decodeUint(hex: unknown): bigint | null {
  try {
    const body = String(hex).replace(/^0x/, "");
    if (body === "") return null;
    return BigInt(`0x${body}`);
  } catch {
    return null;
  }
}

export function decodeBool(hex: unknown): boolean | null {
  const value = decodeUint(hex);
  return value === null ? null : value !== 0n;
}

// ---------------------------------------------------------------------------
// EIP-712
// ---------------------------------------------------------------------------

const DOMAIN_TYPEHASH = keccakHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

export interface Eip712Domain {
  name?: string | undefined;
  version?: string | undefined;
  chainId: number | bigint | string;
  verifyingContract: unknown;
}

export function domainSeparator({ name, version, chainId, verifyingContract }: Eip712Domain): Hex {
  return keccakHex(
    fromHex(
      padLeft(DOMAIN_TYPEHASH) +
        padLeft(keccakHex(name ?? "")) +
        padLeft(keccakHex(version ?? "")) +
        encodeUint(chainId) +
        encodeAddress(verifyingContract),
    ),
  );
}

export interface TransferAuthorization {
  from: string;
  to: string | undefined;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface TransferWithAuthorizationTypedData {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: "TransferWithAuthorization";
  domain: {
    name: string | undefined;
    version: string | undefined;
    chainId: number;
    verifyingContract: string | undefined;
  };
  message: TransferAuthorization;
}

function randomNonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * buildTypedData assembles the EIP-3009 authorization the wallet is asked to sign.
 *
 * The domain fields come from the QUOTE's `extra` rather than from a constant, which is the whole
 * reason x402 carries them: Base mainnet USDC reports "USD Coin" and Base Sepolia reports "USDC",
 * and signing under the wrong one produces a well-formed signature the token rejects with nothing
 * in the error to explain why. `nonce` and `now` are injectable so a test and the fixture
 * generator get a deterministic payload.
 */
export function buildTypedData({
  requirement,
  chainId,
  from,
  amount,
  nonce,
  now,
}: {
  requirement: PaymentRequirement | null | undefined;
  chainId: number;
  from: string;
  amount: string | bigint;
  nonce?: Hex;
  now?: number;
}): TransferWithAuthorizationTypedData {
  const seconds = now ?? Math.floor(Date.now() / 1000);
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    domain: {
      name: requirement?.extra?.name,
      version: requirement?.extra?.version,
      chainId,
      verifyingContract: requirement?.asset,
    },
    message: {
      from,
      to: requirement?.payTo,
      value: String(amount),
      // Backdated sixty seconds so a clock a little ahead of the chain cannot make a fresh
      // authorization look not-yet-valid. validBefore is the quote's own life.
      validAfter: String(seconds - 60),
      validBefore: String(seconds + Number(requirement?.maxTimeoutSeconds || 300)),
      nonce: nonce ?? randomNonce(),
    },
  };
}

export interface SplitSignature {
  v: number;
  r: Hex;
  s: Hex;
}

/**
 * splitSignature turns the 65-byte wallet signature into the (v, r, s) the token's
 * transferWithAuthorization takes. A wallet that returns v as 0 or 1 is normalised to 27/28,
 * which some do and the contract does not accept.
 */
export function splitSignature(signature: string): SplitSignature {
  const body = signature.replace(/^0x/, "");
  if (body.length !== 130) throw new Error(`signature is ${body.length / 2} bytes, want 65`);
  let v = Number.parseInt(body.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { v, r: `0x${body.slice(0, 64)}`, s: `0x${body.slice(64, 128)}` };
}

/**
 * encodeTransferWithAuthorization builds the calldata for a simulated settlement: the exact call
 * the facilitator will make, so an eth_call of it answers "would the token accept this signature"
 * before anything is sent anywhere.
 */
export function encodeTransferWithAuthorization({
  authorization,
  signature,
}: {
  authorization: TransferAuthorization;
  signature: string;
}): Hex {
  const { v, r, s } = splitSignature(signature);
  return callData(
    SELECTORS.transferWithAuthorization,
    encodeAddress(authorization.from),
    encodeAddress(authorization.to),
    encodeUint(authorization.value),
    encodeUint(authorization.validAfter),
    encodeUint(authorization.validBefore),
    encodeBytes32(authorization.nonce),
    encodeUint(v),
    encodeBytes32(r),
    encodeBytes32(s),
  );
}

export { fromHex, keccak256, keccakHex, selector, toHex } from "./keccak.ts";
