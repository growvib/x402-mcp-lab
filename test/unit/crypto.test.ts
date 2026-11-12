// keccak, selectors, checksums and the EIP-712 domain, against published values.
//
// These are the numbers everything else in the tool rests on. A wrong selector would make the
// settlement simulation report "would revert" for a perfectly good signature, which is worse than
// having no simulation at all: a false alarm on the most important row is what gets the row
// switched off.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  domainSeparator,
  encodeTransferWithAuthorization,
  hasValidChecksum,
  SELECTORS,
  splitSignature,
  toChecksumAddress,
} from "../../src/lib/abi.ts";
import { keccakHex, selector } from "../../src/lib/keccak.ts";

test("keccak256 matches the published vectors", () => {
  assert.equal(keccakHex(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccakHex("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(keccakHex("hello"), "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8");
});

test("derived selectors match the published ones", () => {
  // Every one of these is widely published, so they pin the derivation rather than the ABI.
  assert.equal(selector("transfer(address,uint256)"), "0xa9059cbb");
  assert.equal(SELECTORS.balanceOf, "0x70a08231");
  assert.equal(SELECTORS.decimals, "0x313ce567");
  assert.equal(SELECTORS.name, "0x06fdde03");
  assert.equal(SELECTORS.symbol, "0x95d89b41");
  assert.equal(SELECTORS.version, "0x54fd4d50");
  assert.equal(SELECTORS.domainSeparator, "0x3644e515");
  assert.equal(SELECTORS.authorizationState, "0xe94a0102");
  assert.equal(SELECTORS.transferWithAuthorization, "0xe3ee160e");
});

test("EIP-55 checksums round trip and catch a typo", () => {
  // The vectors from EIP-55 itself.
  for (const address of [
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ]) {
    assert.equal(toChecksumAddress(address.toLowerCase()), address);
    assert.equal(hasValidChecksum(address), true);
  }
  // One character of the checksum flipped: the same address, spelled wrong.
  assert.equal(hasValidChecksum("0x5aAeb6053f3E94C9b9A09f33669435E7Ef1BeAed"), false);
  // An unchecksummed address has nothing to verify and is not rejected for it.
  assert.equal(hasValidChecksum("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), true);
});

test("the EIP-712 domain separator matches the spec's own worked example", () => {
  // EIP-712's "Ether Mail" example. This is the one value here that comes from outside this
  // repository, and it is what makes the domain check trustworthy: the tool compares its own
  // computation against the separator a token reports, so if the computation were wrong it would
  // accuse every correct quote of naming the wrong domain.
  assert.equal(
    domainSeparator({
      name: "Ether Mail",
      version: "1",
      chainId: 1,
      verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
    }),
    "0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f",
  );
});

test("the domain of Base mainnet USDC is stable", () => {
  // Our own computation, pinned so a change in the hashing shows up here rather than as a wrong
  // answer about a live payment. The vector above is what proves the computation itself.
  assert.equal(
    domainSeparator({
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    }),
    "0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f",
  );
});

test("a signature splits into the v, r and s the token takes", () => {
  const sig = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
  assert.deepEqual(splitSignature(sig), { v: 27, r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}` });
  // A wallet that returns 0 or 1 is normalised: the contract does not accept those.
  assert.equal(splitSignature(`0x${"11".repeat(32)}${"22".repeat(32)}00`).v, 27);
  assert.throws(() => splitSignature("0x1234"), /want 65/);
});

test("the simulated call is the exact transferWithAuthorization the facilitator makes", () => {
  const data = encodeTransferWithAuthorization({
    authorization: {
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      value: "1500000",
      validAfter: "1",
      validBefore: "2",
      nonce: `0x${"cd".repeat(32)}`,
    },
    signature: `0x${"11".repeat(32)}${"22".repeat(32)}1b`,
  });
  assert.ok(data.startsWith(SELECTORS.transferWithAuthorization));
  // Selector plus nine 32-byte words.
  assert.equal(data.length, 2 + 8 + 9 * 64);
  assert.ok(data.includes("1111111111111111111111111111111111111111"));
  assert.ok(data.includes("2222222222222222222222222222222222222222"));
});
