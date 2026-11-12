// The pre-flight table: everything that has to be true before a wallet is asked to sign.
//
// A pure function of facts that were gathered elsewhere, so the same rows appear in the page, in
// the headless run and in the tests, and so a row can be exercised without a wallet, a chain or a
// server. Each row is something that, if wrong, either sends money somewhere unrecoverable or
// produces a signature the token refuses.
//
// Three states and no others: `ok` (checked and true), `fail` (checked and false, which blocks
// signing), and `unchecked` (there was no way to check it). `unchecked` is never quietly rendered
// as a pass: an unchecked row looks reassuring, and the one row with no way back (the recipient)
// is exactly the one people leave blank.

import { domainSeparator, isAddress, toChecksumAddress } from "./abi.ts";
import {
  atomicToDecimal,
  decimalToAtomic,
  formatUsd,
  isAtomicString,
  type Parity,
  type PaymentRequired,
  type PaymentRequirement,
  parseCaip2,
  railOf,
  requirementAmount,
} from "./x402.ts";

export type CheckState = "ok" | "fail" | "unchecked";

export interface CheckRow {
  id: string;
  label: string;
  value: string;
  state: CheckState;
  why: string;
  /** What to DO about a failed row: whether it is the reader's mistake or the endpoint's. */
  fix?: string | undefined;
}

export interface TokenReadings {
  decimals?: number | null;
  name?: string | null;
  symbol?: string | null;
  version?: string | null;
  domainSeparator?: string | null;
}

export interface WalletReadings {
  address?: string;
  chainId?: number | string;
  balanceAtomic?: string | null;
}

export interface Limits {
  maxSpend?: string;
  expectedPayTo?: string;
  expectedAsset?: string;
}

export interface SimulationReading {
  state: "ok" | "fail" | "skipped";
  detail?: string;
}

export interface EndpointReadings {
  /** The balance the endpoint reports holding for this wallet, in dollars. */
  balanceUSD?: number | null;
  /** Whether the endpoint can hold a balance at all (it publishes a wallet sign-in). */
  spendableBalance?: boolean;
}

/** Everything the caller managed to learn. What it could not learn is absent, and shows as unchecked. */
export interface Facts {
  requirement: PaymentRequirement | null;
  doc?: PaymentRequired | null | undefined;
  parity?: Parity | null | undefined;
  wallet?: WalletReadings;
  token?: TokenReadings;
  guards?: Limits;
  /** What the preset expects to be paid on this requirement's network. */
  knownPayTo?: string;
  nonceUsed?: boolean | null;
  simulation?: SimulationReading | null;
  endpoint?: EndpointReadings;
}

const OK = "ok";
const FAIL = "fail";
const UNCHECKED = "unchecked";

const DO_NOT_PAY_CHANGED =
  "Do not pay. Either the endpoint changed where it wants the money, or this is not the endpoint you think it is.";

function row(id: string, label: string, value: unknown, state: CheckState, why: string, fix?: string): CheckRow {
  return { id, label, value: value === undefined || value === null ? "-" : String(value), state, why, fix };
}

/** The rows for one requirement, by the rail it would be paid on. */
export function preflight(facts: Facts): CheckRow[] {
  const { requirement } = facts;
  if (!requirement) return [];
  return railOf(requirement) === "solana" ? solanaRows(facts, requirement) : evmRows(facts, requirement);
}

export function blockers(rows: readonly CheckRow[]): CheckRow[] {
  return rows.filter((r) => r.state === FAIL);
}

export function unchecked(rows: readonly CheckRow[]): CheckRow[] {
  return rows.filter((r) => r.state === UNCHECKED);
}

// ---------------------------------------------------------------------------

function amountRows(facts: Facts, requirement: PaymentRequirement, rows: CheckRow[]): string | null {
  const { token = {}, guards = {} } = facts;
  const { value: amount, field } = requirementAmount(requirement);
  const decimals = token.decimals ?? 6;

  if (!isAtomicString(amount)) {
    rows.push(
      row(
        "amount",
        field ?? "amount",
        amount,
        FAIL,
        "the amount must be a string of digits in the token's atomic units. A JSON number loses precision above 2^53 and a decimal here means the server is quoting a different unit than it thinks",
        "This is the endpoint's bug, not yours. Do not pay it: the amount it means and the amount you would sign for may differ.",
      ),
    );
    return null;
  }

  const label = field ?? "amount";
  const human = formatUsd(amount, decimals);
  const ceiling = guards.maxSpend ? decimalToAtomic(guards.maxSpend, decimals) : null;

  if (BigInt(amount) === 0n) {
    rows.push(row("amount", label, `${amount} atomic`, FAIL, "a zero amount is not a payment"));
  } else if (ceiling === null) {
    rows.push(
      row(
        "amount",
        label,
        `${amount} atomic = ${human}`,
        UNCHECKED,
        "no spend ceiling set, so nothing limits what this quote can ask for",
      ),
    );
  } else if (BigInt(amount) > ceiling) {
    rows.push(
      row(
        "amount",
        label,
        `${amount} atomic = ${human}`,
        FAIL,
        `over your ceiling of ${formatUsd(ceiling.toString(), decimals)}`,
        "Raise the limit if this price is right, or ask for less.",
      ),
    );
  } else {
    rows.push(
      row(
        "amount",
        label,
        `${amount} atomic = ${human}`,
        OK,
        `under your ceiling of ${formatUsd(ceiling.toString(), decimals)}`,
      ),
    );
  }

  if (token.decimals === undefined || token.decimals === null) {
    // A wrong power of ten is a 1000x error, and the two rails are not in the same position about
    // it. On EVM the token's decimals() is readable and a miss is a failed read, so the figure is
    // an assumption and the row says so. On Solana they live in the mint account, this rail has no
    // RPC by design, and the endpoint chooses the mint: an unknown one leaves the amount a bare
    // integer with no unit at all, where "900000" is ninety cents of USDC or nine hundred thousand
    // whole tokens of a mint with no decimals. The second passes a one dollar ceiling. So there it
    // is a refusal rather than a note.
    rows.push(
      railOf(requirement) === "solana"
        ? row(
            "decimals",
            "mint decimals",
            "unknown",
            FAIL,
            "the decimals of this mint cannot be read without a chain and this tool does not know it, so the amount above has no unit and your ceiling has nothing to bound",
            "Ask this endpoint to publish `decimals` in the requirement's extra, or to quote a mint this tool knows (USDC, USDT).",
          )
        : row(
            "decimals",
            "token decimals",
            "assumed 6",
            UNCHECKED,
            "decimals() could not be read, so the dollar figure above is an assumption. A wrong power of ten is a 1000x error",
          ),
    );
  }
  return amount;
}

/**
 * What the recipient is held to: what you pinned by hand wins, and otherwise what this tool already
 * ships knowing about the source. Nobody should be asked to know a payment address by heart; the
 * point of the row is to notice when the address CHANGES.
 */
function expectedRecipient(facts: Facts): { expected: string; fromPreset: boolean } {
  const pinned = (facts.guards?.expectedPayTo ?? "").trim();
  const expected = pinned || (facts.knownPayTo ?? "").trim();
  return { expected, fromPreset: pinned === "" && expected !== "" };
}

function payToRow(facts: Facts, requirement: PaymentRequirement, rows: CheckRow[]): void {
  const quoted = requirement.payTo;
  const { expected, fromPreset } = expectedRecipient(facts);

  if (!isAddress(quoted)) {
    rows.push(row("payTo", "payTo", quoted, FAIL, "not an address this rail can pay"));
    return;
  }
  const display = toChecksumAddress(quoted);
  if (expected === "") {
    rows.push(
      row(
        "payTo",
        "payTo",
        display,
        UNCHECKED,
        "nothing to compare against. This is the one row with no way back if it is wrong",
        "Paste the address you expect to be paid into your limits, and every later quote is checked against it.",
      ),
    );
    return;
  }
  if (!isAddress(expected)) {
    rows.push(row("payTo", "payTo", display, FAIL, "the address you pinned is not a valid address"));
    return;
  }
  const same = quoted.toLowerCase() === expected.toLowerCase();
  const why = same
    ? fromPreset
      ? "the address this source has always paid to"
      : "matches the address you pinned"
    : fromPreset
      ? `this source is known to pay to ${toChecksumAddress(expected)}`
      : `you pinned ${toChecksumAddress(expected)}`;
  rows.push(row("payTo", "payTo", display, same ? OK : FAIL, why, same ? undefined : DO_NOT_PAY_CHANGED));
}

function assetRow(facts: Facts, requirement: PaymentRequirement): CheckRow {
  const { token = {}, guards = {} } = facts;
  const asset = requirement.asset;
  if (!isAddress(asset)) return row("asset", "asset", asset, FAIL, "not a contract address");
  const display = toChecksumAddress(asset);
  if (guards.expectedAsset) {
    const same = guards.expectedAsset.toLowerCase() === asset.toLowerCase();
    return row(
      "asset",
      "asset",
      token.symbol ? `${display} (${token.symbol})` : display,
      same ? OK : FAIL,
      same ? "matches the token this target is expected to charge in" : "not the token you pinned for this target",
    );
  }
  const named = token.symbol || token.name;
  if (named) {
    return row(
      "asset",
      "asset",
      `${display} (${named})`,
      OK,
      "the contract answers as a token. Anyone can deploy a token with any name, so check the address itself if you have not before",
    );
  }
  return row(
    "asset",
    "asset",
    display,
    UNCHECKED,
    "the contract did not answer name() or symbol(), so nothing here says it is the token you think",
  );
}

function domainRow(facts: Facts, requirement: PaymentRequirement, chainId: number | null): CheckRow {
  const { token = {} } = facts;
  const extraName = requirement.extra?.name;
  const extraVersion = requirement.extra?.version;
  if (extraName === undefined || extraVersion === undefined) {
    return row(
      "domain",
      "extra.name / version",
      `${extraName ?? "missing"} / ${extraVersion ?? "missing"}`,
      FAIL,
      "an EIP-3009 authorization is signed under the token's EIP-712 domain, and the quote has to name it",
    );
  }
  if (token.domainSeparator && chainId !== null && isAddress(requirement.asset)) {
    const computed = domainSeparator({
      name: extraName,
      version: extraVersion,
      chainId,
      verifyingContract: requirement.asset,
    });
    const same = computed.toLowerCase() === token.domainSeparator.toLowerCase();
    return row(
      "domain",
      "EIP-712 domain",
      `${extraName} / ${extraVersion}`,
      same ? OK : FAIL,
      same
        ? "the domain in this quote hashes to the separator the token itself reports"
        : "the token reports a different domain separator. A signature made here would be well formed and refused, with nothing in the error to say why",
      same
        ? undefined
        : "The endpoint is quoting the wrong signing domain. Report it: every payment it asks for will fail the same way.",
    );
  }
  if (token.name) {
    const same = token.name === extraName && (token.version == null || token.version === extraVersion);
    return row(
      "domain",
      "extra.name / version",
      `${extraName} / ${extraVersion}`,
      same ? OK : FAIL,
      same
        ? `matches the token's own name()${token.version ? " and version()" : ""}`
        : `the token reports ${JSON.stringify(token.name)}${token.version ? ` / ${JSON.stringify(token.version)}` : ""}`,
    );
  }
  return row(
    "domain",
    "extra.name / version",
    `${extraName} / ${extraVersion}`,
    UNCHECKED,
    "the token did not answer DOMAIN_SEPARATOR() or name(), so the domain cannot be verified from here",
  );
}

function evmRows(facts: Facts, requirement: PaymentRequirement): CheckRow[] {
  const { doc, wallet = {}, token = {}, parity, nonceUsed, simulation, endpoint = {} } = facts;
  const rows: CheckRow[] = [];
  const caip = parseCaip2(requirement.network);
  const { value: amount } = requirementAmount(requirement);

  payToRow(facts, requirement, rows);

  if (!caip.ok || caip.chainId === null) {
    rows.push(row("network", "network", requirement.network, FAIL, "not a CAIP-2 eip155 network id"));
  } else {
    rows.push(row("network", "network", requirement.network, OK, `chain id ${caip.chainId}`));
  }

  rows.push(assetRow(facts, requirement));
  amountRows(facts, requirement, rows);

  const exact = requirement.scheme === "exact";
  rows.push(
    row(
      "scheme",
      "scheme",
      requirement.scheme,
      exact ? OK : FAIL,
      exact ? "exact: the value must match, not 'up to'" : "this tool signs the exact scheme only",
    ),
  );

  rows.push(domainRow(facts, requirement, caip.chainId));

  const timeout = Number(requirement.maxTimeoutSeconds);
  const live = Number.isFinite(timeout) && timeout > 0;
  rows.push(
    row(
      "maxTimeoutSeconds",
      "maxTimeoutSeconds",
      requirement.maxTimeoutSeconds,
      live ? OK : FAIL,
      live ? "how long this quote stays payable" : "a quote with no life cannot be paid",
    ),
  );

  if (!wallet.address) {
    rows.push(
      row("wallet", "wallet", "not connected", UNCHECKED, "connect a wallet to check the chain and the balance"),
    );
  } else if (caip.chainId !== null) {
    const same = Number(wallet.chainId) === caip.chainId;
    rows.push(
      row(
        "wallet",
        "connected chain",
        wallet.chainId,
        same ? OK : FAIL,
        same ? "your wallet is on the chain this quote names" : `switch to chain ${caip.chainId} before signing`,
        same ? undefined : "The lab will ask your wallet to switch when you pay.",
      ),
    );
  }

  if (wallet.balanceAtomic !== undefined && wallet.balanceAtomic !== null && isAtomicString(amount)) {
    const enough = BigInt(wallet.balanceAtomic) >= BigInt(amount);
    rows.push(
      row(
        "balance",
        "wallet balance",
        atomicToDecimal(wallet.balanceAtomic, token.decimals ?? 6),
        enough ? OK : FAIL,
        enough ? "covers this payment" : "not enough of this token to cover the amount",
        enough ? undefined : shortOfChainBalanceFix(endpoint),
      ),
    );
  } else if (wallet.address) {
    rows.push(row("balance", "wallet balance", "unread", UNCHECKED, "balanceOf() could not be read"));
  }

  if (nonceUsed === true) {
    rows.push(
      row(
        "nonce",
        "authorization nonce",
        "already used",
        FAIL,
        "this nonce has been spent",
        "Ask for a fresh quote: an authorization can only settle once.",
      ),
    );
  } else if (nonceUsed === false) {
    rows.push(row("nonce", "authorization nonce", "unused", OK, "authorizationState() says the token has not seen it"));
  }

  if (parity) {
    rows.push(
      row(
        "parity",
        "header parity",
        parity.ok ? "PAYMENT-REQUIRED" : "mismatch",
        parity.ok ? OK : FAIL,
        parity.why,
        parity.ok
          ? undefined
          : "Do not pay. Two clients reading the same quote would pay different things, so one of them is wrong.",
      ),
    );
  }

  if (simulation?.state === "ok") {
    rows.push(
      row(
        "simulation",
        "settlement simulation",
        "would succeed",
        OK,
        "eth_call of the exact transferWithAuthorization the facilitator will make returns success",
      ),
    );
  } else if (simulation?.state === "fail") {
    rows.push(
      row(
        "simulation",
        "settlement simulation",
        "would revert",
        FAIL,
        simulation.detail || "the token refuses this authorization",
        "Nothing was sent. Re-quote and try once; if it repeats, the quote itself is wrong and the endpoint needs to hear about it.",
      ),
    );
  } else if (simulation?.state) {
    rows.push(
      row(
        "simulation",
        "settlement simulation",
        "not run",
        UNCHECKED,
        simulation.detail || "needs a signature and an RPC",
      ),
    );
  }

  if (doc && !doc.resource?.url) {
    rows.push(
      row(
        "resource",
        "resource.url",
        "missing",
        UNCHECKED,
        "nothing to copy into the payload, so this payment cannot be indexed by a facilitator. It does not affect the money",
      ),
    );
  }

  return rows;
}

/**
 * The Solana rail is checked as far as an offline reader can: the recipient, the amount, the mint
 * and the fee payer the facilitator must supply. The transaction itself is built and signed by the
 * wallet, and the facilitator, which resolves lookup tables against the chain, is authoritative.
 */
function solanaRows(facts: Facts, requirement: PaymentRequirement): CheckRow[] {
  const { wallet = {} } = facts;
  const rows: CheckRow[] = [];
  const { expected, fromPreset } = expectedRecipient(facts);

  if (!requirement.payTo) {
    rows.push(row("payTo", "payTo", "missing", FAIL, "no recipient"));
  } else if (expected === "") {
    rows.push(
      row(
        "payTo",
        "payTo",
        requirement.payTo,
        UNCHECKED,
        "nothing to compare against. This is the one row with no way back if it is wrong",
        "Paste the address you expect to be paid into your limits; base58 is case sensitive and has one spelling.",
      ),
    );
  } else {
    // Base58 is case sensitive, so this is an exact compare and not a lowercased one.
    const same = expected === requirement.payTo;
    const why = same
      ? fromPreset
        ? "the address this source has always paid to"
        : "matches the address you pinned"
      : fromPreset
        ? `this source is known to pay to ${expected}`
        : `you pinned ${expected}`;
    rows.push(row("payTo", "payTo", requirement.payTo, same ? OK : FAIL, why, same ? undefined : DO_NOT_PAY_CHANGED));
  }

  // The same amount check the EVM rail gets, not a second one that only looks at the shape. The
  // spend ceiling is the one number set by hand in this tool, and a rail that reads it as
  // decoration is worse than a rail that never offered to pay at all.
  amountRows(facts, requirement, rows);
  rows.push(row("asset", "mint", requirement.asset, requirement.asset ? OK : FAIL, "the SPL mint the transfer moves"));
  const feePayer = requirement.extra?.feePayer;
  rows.push(
    row(
      "feePayer",
      "extra.feePayer",
      feePayer ?? "missing",
      feePayer ? OK : FAIL,
      "under the Solana scheme the facilitator's account pays the fee and signs last. A fee payer we invented would fail every payment at verify",
    ),
  );
  rows.push(
    row(
      "wallet",
      "wallet",
      wallet.address || "not connected",
      wallet.address ? OK : UNCHECKED,
      wallet.address ? "a Solana wallet is connected" : "connect a Solana wallet (Phantom, Solflare) to pay this rail",
    ),
  );
  return rows;
}

/**
 * What to actually do about an on-chain balance that does not cover the payment.
 *
 * "Top up this wallet" is the right answer for a resource that only takes chain payments, and the
 * wrong one for a resource that is already holding money for you: a minimum payment leaves a
 * remainder behind, so the person staring at this row may well have enough sitting on the endpoint.
 */
function shortOfChainBalanceFix(endpoint: EndpointReadings): string {
  if (endpoint.balanceUSD !== null && endpoint.balanceUSD !== undefined) {
    return `You hold $${endpoint.balanceUSD} on this endpoint already. Pay from that instead, below: no signature and nothing on chain.`;
  }
  if (endpoint.spendableBalance) {
    return 'This endpoint may be holding a balance for you from an earlier payment. See "Or pay from your balance here" below, which needs no signature and nothing on chain.';
  }
  return "Top up this wallet, or choose something cheaper.";
}
