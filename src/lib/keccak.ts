// keccak256 with no dependencies.
//
// It is here so that nothing in this tool is a copied constant. A function selector and an EIP-712
// domain separator are both keccak hashes, and a tool whose job is to say "this signature would be
// accepted" cannot itself be pasting four bytes it read somewhere and hoping. Everything derived
// from this file is checked against published vectors in test/unit/crypto.test.ts, including the
// selectors of functions whose selectors are widely published, so a mistake here fails a test
// rather than producing a confident wrong answer about a payment.
//
// Lanes are BigInts. A 32-bit split is faster and much easier to get subtly wrong; this hashes
// strings of a few dozen bytes a handful of times per run, so speed is not a consideration.

const MASK = (1n << 64n) - 1n;

const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

// The rho rotation offsets and the pi lane permutation, in the order the reference
// implementation's single rho-pi loop consumes them.
const ROTATIONS: readonly number[] = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];
const PI_LANES: readonly number[] = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];

/** 1600 bits of state minus 512 bits of capacity, in bytes. */
const RATE = 136;

function rotl(x: bigint, n: number): bigint {
  const shift = BigInt(n);
  return ((x << shift) | (x >> (64n - shift))) & MASK;
}

// The state is a fixed 25-lane array and every index below is in range by construction, so the
// lane reads go through `lane()` rather than scattering non-null assertions across the rounds.
function lane(values: readonly bigint[], index: number): bigint {
  return values[index] ?? 0n;
}

function permute(state: bigint[]): void {
  const bc: bigint[] = [0n, 0n, 0n, 0n, 0n];
  for (let round = 0; round < 24; round++) {
    // theta
    for (let i = 0; i < 5; i++) {
      bc[i] = lane(state, i) ^ lane(state, i + 5) ^ lane(state, i + 10) ^ lane(state, i + 15) ^ lane(state, i + 20);
    }
    for (let i = 0; i < 5; i++) {
      const t = lane(bc, (i + 4) % 5) ^ rotl(lane(bc, (i + 1) % 5), 1);
      for (let j = 0; j < 25; j += 5) state[j + i] = lane(state, j + i) ^ t;
    }
    // rho and pi, as one walk of the lane permutation
    let carry = lane(state, 1);
    for (let i = 0; i < 24; i++) {
      const j = PI_LANES[i] ?? 0;
      const next = lane(state, j);
      state[j] = rotl(carry, ROTATIONS[i] ?? 0);
      carry = next;
    }
    // chi
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i++) bc[i] = lane(state, j + i);
      for (let i = 0; i < 5; i++) {
        state[j + i] = lane(bc, i) ^ (~lane(bc, (i + 1) % 5) & MASK & lane(bc, (i + 2) % 5));
      }
    }
    // iota
    state[0] = lane(state, 0) ^ lane(ROUND_CONSTANTS, round);
  }
}

/**
 * keccak256 takes bytes (or a string, hashed as UTF-8) and returns the 32-byte digest.
 *
 * The padding is Keccak's original 0x01, NOT SHA3's 0x06: they differ by that one byte and produce
 * completely different digests, which is the classic way an implementation passes a smoke test
 * against nothing and fails against Ethereum.
 */
export function keccak256(input: Uint8Array | string): Uint8Array {
  const bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(input);
  const state: bigint[] = new Array<bigint>(25).fill(0n);

  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / RATE) * RATE);
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;

  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let index = 0; index < RATE / 8; index++) {
      let value = 0n;
      for (let b = 7; b >= 0; b--) value = (value << 8n) | BigInt(padded[offset + index * 8 + b] ?? 0);
      state[index] = lane(state, index) ^ value;
    }
    permute(state);
  }

  const out = new Uint8Array(32);
  for (let index = 0; index < 4; index++) {
    let value = lane(state, index);
    for (let b = 0; b < 8; b++) {
      out[index * 8 + b] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return out;
}

export function toHex(bytes: Uint8Array): `0x${string}` {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `0x${hex}`;
}

export function fromHex(hex: string): Uint8Array {
  const text = hex.replace(/^0x/i, "");
  if (text.length % 2 !== 0 || /[^0-9a-f]/i.test(text)) throw new Error(`not hex: ${hex}`);
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function keccakHex(input: Uint8Array | string): `0x${string}` {
  return toHex(keccak256(input));
}

/**
 * selector derives the four bytes that open a call to `signature`, e.g. "balanceOf(address)".
 * Every selector this tool sends is produced here rather than pasted, so a typo cannot survive as
 * a wrong answer about whether a payment would work.
 */
export function selector(signature: string): `0x${string}` {
  return toHex(keccak256(signature).slice(0, 4));
}
