// The point of the tool: what you are about to sign, and the rails in front of signing.
//
// Two rules hold this file together.
//
//   1. Passing checks are a count, failing checks are the page. Ten green rows with explanations
//      are ten rows nobody reads, which is how the one red row gets missed.
//   2. A check that fails blocks signing in the HANDLER, not only on the button. A disabled
//      attribute is a hint; a click dispatched past it still reaches the wallet unless something
//      re-evaluates the checks at the moment of signing, which is what pay() does.

import {
  app,
  connectSolanaWallet,
  currentTarget,
  gate,
  http,
  paintNetwork,
  record,
  recordChecks,
  rememberAgentToken,
  rememberBalance,
  render,
  signInState,
  signInWithWallet,
  startRun,
} from "../../app.ts";
import { buildTypedData } from "../../lib/abi.ts";
import { coverage, idempotencyKeyFor, orderFromBalance, readBalance, walletAuthOf } from "../../lib/agent.ts";
import { catalogOf } from "../../lib/catalog.ts";
import { blockers, type CheckRow, preflight } from "../../lib/checks.ts";
import { isSimulation } from "../../lib/guard.ts";
import { errorMessage, isRecord, type JsonRecord } from "../../lib/json.ts";
import { chooseOne } from "../../lib/modal.ts";
import { networkMark } from "../../lib/netmark.ts";
import { buildPaymentMessage, signedByPayer, solanaExtra, toBase64, unsignedTransaction } from "../../lib/solana.ts";
import { discoverSolanaWallets } from "../../lib/solana-wallet.ts";
import type { Guards } from "../../lib/types.ts";
import { busyLabel, debounce, el } from "../../lib/ui.ts";
import {
  buildPaymentPayload,
  encodeBase64Json,
  formatUsd,
  isAtomicString,
  type PaymentRequirement,
  parseCaip2,
  parseQuote,
  type RailedRequirement,
  railOf,
  requirementAmount,
  selectRequirements,
} from "../../lib/x402.ts";
import { facts, gatherFacts } from "./facts.ts";
import { fail, hint, metric, money, networkName, safeJson, serverMessage, shortAddress } from "./format.ts";
import { sendMcp } from "./mcp.ts";
import { clearPayment, goTo, type Outcome, readBody, state } from "./state.ts";

const NOT_OPENED = "Your wallet was not opened.";

/** The atomic amount a requirement asks for, as a string a signer can take, or null when it has none. */
function atomicAmount(requirement: PaymentRequirement): string | null {
  const { value } = requirementAmount(requirement);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return isAtomicString(value) ? value : null;
}

/** A JSON object read off a response, or null for anything else. */
function jsonObject(text: string): JsonRecord | null {
  const parsed = safeJson(text);
  return isRecord(parsed) ? parsed : null;
}

function stringField(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Re-evaluates the checks at the moment of signing. Returns true when signing must stop. */
function blockedByChecks(): boolean {
  const s = state();
  const failing = blockers(preflight(facts()));
  if (!failing.length) return false;
  s.checksOpen = true;
  s.error = `Not signed: ${failing.map((row) => row.label).join(", ")} failed. ${NOT_OPENED}`;
  render();
  return true;
}

/** Asks the session gate whether a payment may start. Returns true when it may not. */
function refusedByGate(report: (reason: string) => void): boolean {
  const refusal = gate.check();
  if (!refusal) return false;
  report(refusal);
  render();
  return true;
}

export async function getQuote(): Promise<void> {
  const s = state();
  const target = currentTarget();
  startRun();
  clearPayment(s);
  s.error = null;

  let body: JsonRecord | undefined;
  try {
    body = target.method === "GET" ? undefined : readBody();
  } catch (error) {
    s.error = errorMessage(error);
    render();
    return;
  }

  // The request takes as long as the endpoint takes, and until this there was nothing on screen
  // saying it had started. A page that looks inert after a press is a page that gets pressed again.
  s.busy = "Asking the endpoint...";
  render();

  let res: Awaited<ReturnType<typeof http>>;
  try {
    res = await http({ method: target.method, path: target.resource, body, note: "Payment quote requested" });
  } finally {
    s.busy = null;
  }
  s.raw402 = res;

  if (res.transportError) {
    s.error = res.transportError;
    render();
    return;
  }
  if (res.status !== 402) {
    s.error = `This endpoint answered ${res.status} instead of asking for payment. ${serverMessage(res)}`;
    render();
    return;
  }

  s.quote = parseQuote({ status: res.status, body: res.body, headers: res.headers });
  const entries = selectRequirements(s.quote.doc);
  s.railIndex = Math.min(s.railIndex, Math.max(entries.length - 1, 0));
  s.requirement = entries[s.railIndex]?.req ?? null;
  await gatherFacts();
  goTo("review");
}

export async function pay({ dryRun = false }: { dryRun?: boolean } = {}): Promise<void> {
  const s = state();
  s.error = null;

  const wallet = app.wallet;
  const requirement = s.requirement;
  if (!wallet) {
    s.error = "Connect a wallet first. The lab never holds a key: your wallet signs.";
    render();
    return;
  }
  if (!requirement) return;

  // Rail 1: the checks, re-evaluated here rather than trusted from the render that drew the button.
  if (blockedByChecks()) return;

  // Rail 2: should a payment happen at all right now.
  if (!dryRun) {
    if (refusedByGate((reason) => (s.error = reason))) return;
    gate.begin();
  }

  s.busy = dryRun ? "Signing..." : "Waiting for your wallet...";
  render();

  let paid = false;
  try {
    const { chainId } = parseCaip2(requirement.network);
    if (chainId === null) throw new Error(`${requirement.network ?? "this network"} is not an EVM chain id`);
    if (wallet.chainId !== chainId) {
      await wallet.client.switchChain(chainId);
      wallet.chainId = await wallet.client.chainId();
    }

    const amount = atomicAmount(requirement);
    if (amount === null) throw new Error("the quote carries no atomic amount to authorize");
    const typed = buildTypedData({ requirement, chainId, from: wallet.address, amount });
    s.typed = typed;

    // A used nonce can never settle, so it is checked before the wallet is opened rather than
    // after a signature has been taken for nothing.
    s.nonceUsed = await wallet.client.authorizationState(requirement.asset ?? "", wallet.address, typed.message.nonce);
    if (s.nonceUsed === true) {
      s.error = "The generated nonce is already spent at the contract. Get a fresh quote.";
      return;
    }

    const signature = await wallet.client.signTypedData(wallet.address, typed);
    s.signature = signature;
    record({
      method: "wallet",
      url: "eth_signTypedData_v4",
      status: "signed",
      note: "Payment authorization signed",
      at: new Date().toISOString(),
    });

    const simulation = await wallet.client.simulateSettlement({
      asset: requirement.asset ?? "",
      authorization: typed.message,
      signature,
      from: wallet.address,
    });
    s.simulation = simulation;
    record({
      method: "chain",
      url: "eth_call transferWithAuthorization",
      status: simulation.state === "ok" ? "would succeed" : "would revert",
      note: simulation.state === "ok" ? "Settlement simulated against the token" : simulation.detail,
      at: new Date().toISOString(),
    });

    s.payload = buildPaymentPayload({
      doc: s.quote?.doc ?? s.mcpDoc,
      requirement,
      proof: { signature, authorization: typed.message },
    });
    recordChecks(preflight(facts()));

    if (dryRun) {
      s.error = null;
      return;
    }
    if (simulation.state === "fail") {
      s.error = `Not sent: the token would refuse this payment (${simulation.detail}). Nothing has moved.`;
      return;
    }

    await send("pay");
    paid = true;
  } catch (error) {
    s.error = errorMessage(error);
  } finally {
    s.busy = null;
    if (!dryRun) gate.end({ paid });
    render();
  }
}

// ---------------------------------------------------------------------------
// Paying on Solana
//
// The EVM rail signs an authorization and lets the facilitator make the transfer. This rail signs
// the TRANSFER, in a transaction whose fee payer is the facilitator, so the payer needs no SOL and
// the facilitator can submit it. Everything it takes to build that is in the quote (lib/solana.ts
// explains the format), so this function is the same shape as pay() with a different instrument:
// the same checks, the same gate, the same send.
// ---------------------------------------------------------------------------

export async function paySolana(): Promise<void> {
  const s = state();
  s.error = null;
  const requirement = s.requirement;
  if (!requirement) return;

  // A Solana quote with no fee payer is unpayable by anybody, not just by this tool, and saying
  // which field is missing beats failing later on an address that is not an address.
  const extra = solanaExtra(requirement);
  if (extra.missing.length) {
    s.error =
      `This Solana quote cannot be paid: it carries no ${extra.missing.join(" and no ")}. ` +
      "The facilitator supplies both, so a fresh quote usually has them.";
    render();
    return;
  }

  // Rail 1: the checks, re-evaluated here rather than trusted from the render that drew the button.
  // Before the wallet, not after: "your wallet was not opened" has to be true, and a connect dialog
  // for a payment that was never going to happen is still a dialog.
  if (blockedByChecks()) return;

  if (!app.solana) {
    const connected = await connectSolanaWallet();
    if ("error" in connected) {
      if (connected.cancelled || connected.error === null) return;
      s.error = connected.error;
      render();
      return;
    }
  }
  const solana = app.solana;
  if (!solana) return;

  // Rail 2: should a payment happen at all right now.
  if (refusedByGate((reason) => (s.error = reason))) return;
  gate.begin();

  s.busy = "Waiting for your wallet...";
  render();

  let paid = false;
  try {
    const amount = atomicAmount(requirement);
    if (amount === null) throw new Error("the quote carries no atomic amount to transfer");
    const built = await buildPaymentMessage({
      payer: solana.address,
      payTo: requirement.payTo ?? "",
      mint: requirement.asset ?? "",
      amountAtomic: amount,
      feePayer: extra.feePayer,
      recentBlockhash: extra.recentBlockhash,
      memo: extra.memo,
    });
    // Kept for the inspector: on this rail the thing being signed is a transaction, and being able
    // to read which accounts it touches is the whole reason to use a lab rather than an agent.
    s.solanaTransfer = {
      from: built.source,
      to: built.destination,
      owner: solana.address,
      feePayer: extra.feePayer,
      recentBlockhash: extra.recentBlockhash,
      form: built.checked ? "TransferChecked" : "Transfer",
      memo: built.memo,
      accounts: built.keys,
    };
    render();

    // The wallet is handed the whole transaction, signature slots and all, because it decodes
    // those bytes itself to show the payer what they are approving.
    const signed = await solana.client.signTransaction(unsignedTransaction(built.message));
    const wrong = signedByPayer(signed, built.message);
    if (wrong) {
      s.error = `Not sent: ${wrong}. Nothing has moved.`;
      return;
    }
    record({
      method: "wallet",
      url: "solana:signTransaction",
      status: "signed",
      note: `Solana transfer signed by ${solana.address}`,
      at: new Date().toISOString(),
    });

    s.payload = buildPaymentPayload({
      doc: s.quote?.doc ?? s.mcpDoc,
      requirement,
      proof: { transaction: toBase64(signed) },
    });
    recordChecks(preflight(facts()));

    await send("pay");
    paid = true;
  } catch (error) {
    s.error = errorMessage(error);
  } finally {
    s.busy = null;
    gate.end({ paid });
    render();
  }
}

/**
 * Posts the SAME body the quote was taken for, deliberately: an x402 client sends one request twice
 * and the second one pays, so a body edited between the two would be paying for a quote that was
 * never issued.
 */
export async function send(what: Outcome): Promise<void> {
  const s = state();
  if (s.transport === "mcp") return sendMcp(what);

  const target = currentTarget();
  const res = await http({
    method: target.method,
    path: target.resource,
    headers: { "PAYMENT-SIGNATURE": encodeBase64Json(s.payload) },
    body: s.body ?? target.sampleBody,
    note: what === "replay" ? "Replay of the identical signed payment" : "Payment sent",
  });
  s.result = { res, what };
  const parsed = jsonObject(res.body);
  const token = stringField(parsed, "agent_token");
  if (token) rememberAgentToken(token);
  const orderId = stringField(parsed, "order_id");
  if (what === "pay" && orderId) s.firstOrderId = orderId;
  goTo("result");
}

// ---------------------------------------------------------------------------
// The review step

export function stepReview(): HTMLElement {
  const s = state();
  const requirement = s.requirement;
  if (!requirement) {
    return el("div", { class: "callout info" }, el("div", { class: "callout-body" }, "No payment requirements yet."));
  }

  const target = currentTarget();
  const rows = preflight(facts());
  const failing = blockers(rows);
  const unchecked = rows.filter((row) => row.state === "unchecked");
  const { value: amount } = requirementAmount(requirement);
  const rail = railOf(requirement);
  const simulation = isSimulation(target);
  const entries = selectRequirements(s.quote?.doc ?? s.mcpDoc);
  const symbol = s.token.symbol || "USDC";

  // Both routes to the same order live in ONE card, and their buttons in one row.
  //
  // They were two cards, and the balance one moved above or below the quote depending on which
  // route was open. A person looking at the action row saw a blocked button, and the thing that
  // would actually have placed the order was a card away, off the bottom of the screen. Two routes
  // to one outcome belong side by side, where choosing between them is a glance rather than a scroll.
  const balanceOffered = walletAuthOf(target) !== null || app.agentToken !== null;
  // Blocked checks are about the on-chain settlement and say nothing about a balance, so when they
  // block, the balance is the route that is open and takes the primary styling. A Solana quote
  // where no Solana wallet is installed is the same situation by another route.
  const balanceLeads = balanceOffered && (failing.length > 0 || (rail === "solana" && !solanaWalletAvailable()));

  // The network lives in the top bar, beside the wallet and the balance, because it is the state of
  // the session rather than a detail of this card: which one is selected decides what gets signed,
  // what signs it, and where the money goes.
  const network = requirement.network ?? "";
  paintNetwork({
    network,
    label: networkName(network),
    count: entries.length,
    onPick: () => void pickNetwork(entries),
  });

  const blockedLabel = `Blocked · ${failing.length} check${failing.length === 1 ? "" : "s"} failed`;
  const settleLabel =
    rail === "solana"
      ? `${simulation ? "Simulate" : "Pay"} ${money(amount)} on Solana`
      : `${simulation ? "Simulate" : "Pay"} ${money(amount)}`;

  return el(
    "div",
    { class: "stack" },
    el(
      "div",
      { class: "card" },
      el("div", { class: "card-head" }, el("h3", {}, "Your payment quote"), el("div", { class: "grow" })),
      el(
        "div",
        { class: "card-body" },
        el(
          "div",
          {},
          el(
            "div",
            { class: "amount" },
            el("b", {}, (amount ? formatUsd(amount, s.token.decimals ?? 6) : null) ?? "?"),
            el("span", {}, symbol),
          ),
          el("div", { class: "help", style: { marginTop: "6px" } }, selectionLine()),
        ),

        el(
          "div",
          { class: "metrics two" },
          metric("Network", networkName(network), network),
          // The detail under the recipient is read from the check, never from "did they pin
          // something": a pinned address that does NOT match is exactly when this line matters.
          metric("Recipient", shortAddress(requirement.payTo), recipientNote(rows)),
          metric(
            "Your payment limit",
            app.guards.maxSpend ? `${app.guards.maxSpend} ${symbol} per request` : "not set",
            "Change it below",
          ),
          metric("Quote valid for", `${requirement.maxTimeoutSeconds ?? "?"} seconds`, "after that, ask again"),
        ),

        checksSection(rows, failing, unchecked),

        balanceSection({ lead: balanceLeads }),
      ),

      el(
        "div",
        { class: "card-foot" },
        el(
          "button",
          {
            // A stable hook, because which of the two routes wears the primary styling depends on
            // which one is open, and a selector that reads the styling is a selector that breaks
            // when the styling is the thing being decided.
            id: "paySettleButton",
            class: `lg ${balanceLeads ? "" : "primary"}`,
            disabled: s.busy !== null || failing.length > 0 || (rail === "solana" && !solanaWalletAvailable()),
            onClick: () => void (rail === "solana" ? paySolana() : pay({ dryRun: false })).catch(fail),
          },
          s.busy ? busyLabel(s.busy) : failing.length ? blockedLabel : settleLabel,
        ),
        rail === "evm"
          ? el(
              "button",
              { disabled: s.busy !== null, onClick: () => void pay({ dryRun: true }).catch(fail) },
              "Sign without sending",
            )
          : null,
        // The second route, in the same row as the first. It needs no chain, so it is offered on
        // the Solana rail too, where the settling path is not something this lab can take at all.
        balanceOffered ? balanceButton({ lead: balanceLeads }) : null,
        el("div", { class: "grow" }),
        el("span", { class: "help" }, footNote(rail, failing.length > 0, balanceOffered, simulation)),
      ),
    ),

    limitsCard(),
    app.mode === "guided"
      ? hint(
          "A payment request is part of the handshake.",
          "HTTP 402 tells the client what payment is required. Nothing has been charged yet.",
        )
      : null,
    app.mode === "advanced" && s.typed ? inspectorBlock("Signed authorization", s.typed) : null,
    // On Solana the thing signed is a transaction, and which accounts it touches is the question
    // somebody opens a lab to answer. The derived token accounts especially: they are computed
    // here rather than read from a chain, so being able to check one against an explorer is the
    // difference between trusting this page and verifying it.
    app.mode === "advanced" && s.solanaTransfer ? inspectorBlock("Signed Solana transfer", s.solanaTransfer) : null,
  );
}

function inspectorBlock(title: string, value: unknown): HTMLElement {
  return el(
    "details",
    { class: "inspector" },
    el("summary", {}, title),
    el("div", { style: { padding: "16px" } }, el("pre", {}, JSON.stringify(value, null, 2))),
  );
}

function footNote(rail: string, blocked: boolean, balanceOffered: boolean, simulation: boolean): string {
  if (rail === "solana" && !solanaWalletAvailable()) {
    return "No Solana wallet found. Phantom, Solflare and Backpack are the ones this looks for.";
  }
  if (blocked && balanceOffered)
    return "These checks guard the on-chain payment. Paying from your balance needs none of them.";
  if (simulation) return "Test the handshake. No real money moves.";
  const remaining = `${gate.remaining()} payments left in this session`;
  if (rail === "solana") return app.solana ? remaining : "Your Solana wallet signs the transfer itself.";
  return app.wallet ? remaining : "Connect a wallet to pay";
}

// ---------------------------------------------------------------------------
// Paying out of the balance this endpoint already holds
//
// The same money, a different instrument. There is no signature, no chain and no recipient, so the
// ten payment checks do not apply to it: what it needs is a balance that covers the price, and the
// same rails that stand in front of signing, because it spends just as much.
//
// The order is priced and placed by one request, since sending the token without a payment IS the
// order. That is why this is a deliberate button rather than something the quote step does.
// ---------------------------------------------------------------------------

/**
 * What the balance route needs somebody to READ: what this money is, why the quoted amount is not
 * its price, and whatever went wrong last time. The action itself is balanceButton, in the card's
 * own action row beside the settling one.
 */
export function balanceSection({ lead = false }: { lead?: boolean } = {}): HTMLElement | null {
  const s = state();
  if (!walletAuthOf(app.target) && !app.agentToken) return null;

  // The amount on the quote is what this endpoint will SETTLE, which is its minimum payment
  // whenever the order costs less than that. The order is charged its own price. So the quote is
  // an upper bound on a balance order and nothing more, and treating it as the price would both
  // overstate what this costs and refuse a balance that actually covers it.
  const { value: ask } = requirementAmount(s.requirement);
  const quoted = ask ? Number(ask) / 10 ** (s.token.decimals ?? 6) : null;
  const cover = coverage({ balance: app.agentBalance, price: quoted });
  const mismatch = domainMismatch();

  return el(
    "div",
    { class: `balance-route${lead ? " lead" : ""}` },
    el(
      "div",
      { class: "balance-head" },
      el("b", {}, "Pay from your balance here"),
      el("div", { class: "grow" }),
      app.agentBalance !== null ? el("span", { class: "pill ok" }, `$${app.agentBalance} spendable`) : null,
    ),
    el(
      "p",
      { class: "help" },
      "This endpoint asks for a minimum payment, so anything you paid above an order's price is still here. " +
        "Spending it places the order with no signature and nothing on chain, and takes the order's own price " +
        `rather than the ${quoted !== null ? money(ask) : "quoted"} above.`,
    ),

    // The sign-in is not a step to go and find: the button in the action row gets its own
    // credential. This only says what is about to happen in the wallet.
    !app.agentToken
      ? el(
          "p",
          { class: "help" },
          el("b", {}, "Your wallet signs a message first. "),
          "That is how the endpoint learns which wallet is asking. It moves no funds, approves no " +
            "payment, and touches no chain, and the order follows straight after.",
        )
      : null,

    // Only when there is one to explain. An ERC-4361 message names the authority asking for it,
    // and this endpoint names the page where it recognises the page, so a local run of this lab
    // gets no warning at all and a warning about a warning would be noise. When the names do
    // differ, this appears while the wallet dialog is opening.
    !app.agentToken && mismatch
      ? el(
          "p",
          { class: "help" },
          el("b", {}, "Your wallet is warning about a domain mismatch. "),
          `The message names ${mismatch}, and this page is served from ${pageHost()}. ` +
            "That is the wallet doing its job. The message itself says it moves no funds and " +
            "approves no payment, and it is worth reading before you confirm.",
        )
      : null,

    // Not shown for the attempt made on connect: that one asked without being told to, and a
    // declined signature is a reasonable answer, not a failure to put in red on a page somebody
    // has not yet asked anything of. The badge in the top bar still carries it, and pressing the
    // button asks again and reports it properly.
    signInState.error && !signInState.quiet
      ? el("div", { class: "callout bad" }, el("div", { class: "callout-body" }, signInState.error))
      : null,

    // Not a refusal: the quote is the minimum, so a balance under it may still cover the order.
    // The endpoint is the only thing that knows, and its answer costs nothing.
    app.agentToken && cover.known && !cover.covers
      ? el(
          "div",
          { class: "callout warn" },
          el(
            "div",
            { class: "callout-body" },
            `Your balance is under the ${money(ask)} quoted, which is this endpoint's minimum rather than this order's price. ` +
              "The order may still cost less than you hold. If it does not, the endpoint answers with a payment request and nothing is charged.",
          ),
        )
      : null,

    s.balanceError ? el("div", { class: "callout bad" }, el("div", { class: "callout-body" }, s.balanceError)) : null,
  );
}

const BALANCE_BUSY = "Placing the order...";

/**
 * One button for one outcome. Signing in is a step this tool needs, not a thing anybody wants, so
 * pressing this without a credential gets one and carries on. The version that made you find a
 * second button first cost three rounds of "it does not work".
 */
export function balanceButton({ lead = false }: { lead?: boolean } = {}): HTMLButtonElement {
  const s = state();
  return el(
    "button",
    {
      id: "payBalanceButton",
      class: `lg ${lead ? "primary" : ""}`,
      disabled: s.busy !== null || signInState.busy || !app.wallet,
      onClick: () => void payFromBalance().catch(fail),
    },
    signInState.busy
      ? busyLabel("Waiting for your wallet...")
      : s.busy === BALANCE_BUSY
        ? busyLabel(s.busy)
        : "Pay from balance",
  );
}

/**
 * The authority the sign-in message named, when that differs from the page this lab is served from,
 * and nothing otherwise. Read from the message the wallet is showing, not guessed from the source's
 * origin: the endpoint decides what goes in that field, and guessing produced a warning on every
 * sign-in including the ones with nothing wrong.
 */
function domainMismatch(): string {
  const named = app.signInAuthority;
  if (!named) return "";
  return named.toLowerCase() === pageHost().toLowerCase() ? "" : named;
}

function pageHost(): string {
  return window.location.host || "this page";
}

/**
 * Whether there is a Solana wallet to talk to at all. Read at render time rather than cached: an
 * extension that finishes injecting after the page loads is the ordinary case, not the exception.
 */
function solanaWalletAvailable(): boolean {
  return app.solana !== null || discoverSolanaWallets().length > 0;
}

/**
 * Choosing between the rails a quote offers. The same dialog the wallet picker uses, because it is
 * the same kind of question and a second kind of menu is a second thing to learn.
 */
async function pickNetwork(entries: RailedRequirement[]): Promise<void> {
  const s = state();
  const chosen = await chooseOne({
    title: "Which network should pay?",
    note: "This endpoint quoted the same price on each. They are different chains, different wallets and different money: nothing bridges between them.",
    items: entries.map((entry, index) => {
      const network = entry.req.network ?? "";
      return {
        value: index,
        label: networkName(network),
        sub: network,
        icon: () => networkMark(network, { size: 22, label: networkName(network) }),
        selected: index === s.railIndex,
      };
    }),
    cancelLabel: "Keep this one",
  });
  const entry = chosen ? entries[chosen.value] : undefined;
  if (!chosen || !entry || chosen.value === s.railIndex) return;

  s.railIndex = chosen.value;
  s.requirement = entry.req;
  // Everything downstream belonged to the other rail: a signature over its typed data, a payload
  // naming its network, a simulation against its token.
  s.signature = null;
  s.payload = null;
  s.simulation = null;
  s.solanaTransfer = null;
  await gatherFacts();
  render();
}

async function payFromBalance(): Promise<void> {
  const s = state();
  s.balanceError = null;
  s.error = null;

  // No credential yet: get one. This is a signature over a message, not a payment, so it happens
  // before the payment rails rather than inside them, and a refusal here stops the whole thing
  // without having touched the gate.
  if (!app.agentToken) {
    const signedIn = await signInWithWallet();
    if (!signedIn) return;
  }

  // The same rails as signing, because this spends the same money: one payment at a time, a
  // cooldown between them, and a cap per session. A balance order moves no coins on chain, but it
  // does buy something.
  if (refusedByGate((reason) => (s.balanceError = reason))) return;
  gate.begin();

  s.busy = BALANCE_BUSY;
  render();

  try {
    const target = currentTarget();
    const body = s.body ?? target.sampleBody;
    const selection = JSON.stringify(body);
    // One key per selection, kept on the run: a retry of the same order must carry the key the
    // first attempt used, or the server places a second one.
    if (!s.idempotencyKey || s.idempotencyKeyFor !== selection) {
      s.idempotencyKey = idempotencyKeyFor(body);
      s.idempotencyKeyFor = selection;
    }

    const placed = await orderFromBalance({
      http,
      target,
      body,
      token: app.agentToken,
      idempotencyKey: s.idempotencyKey,
    });
    if (!placed.res || placed.error) {
      s.balanceError = placed.error;
      return;
    }
    const { res } = placed;

    const parsed = jsonObject(res.body);
    const token = stringField(parsed, "agent_token");
    if (token) rememberAgentToken(token, { balance: readBalance(parsed) });
    else rememberBalance(readBalance(parsed));

    // A 402 here means the endpoint priced it and the balance did not cover it, which is an answer
    // rather than a failure: the ordinary paying path above is still open.
    if (res.status === 402) {
      s.balanceError =
        serverMessage(res) || "The endpoint asked for a payment instead: your balance does not cover this order.";
      return;
    }
    if (res.status >= 400) {
      // A refusal that names the order you already have is more useful than the refusal alone: a
      // duplicate target answers 409 with the existing order, which is the thing you want to look
      // at rather than something to buy around.
      const existingId = stringField(parsed, "existing_order_id");
      const existing = existingId ? ` You already have ${existingId} for this link.` : "";
      s.balanceError = `The order was refused (${res.status}). ${serverMessage(res)}${existing}`;
      return;
    }

    s.result = { res, what: "balance" };
    const orderId = stringField(parsed, "order_id");
    if (orderId) s.firstOrderId = orderId;
    goTo("result");
  } finally {
    s.busy = null;
    gate.end();
    render();
  }
}

/**
 * The line under the recipient, in the check's own words rather than in a second set of them. The
 * row is the one that knows where the comparison came from, so the row is the one that gets to say.
 */
function recipientNote(rows: readonly CheckRow[]): string {
  const row = rows.find((entry) => entry.id === "payTo");
  if (!row) return "";
  if (row.state === "fail") return `NOT expected: ${row.why}`;
  return row.why;
}

/** What the money is for, in the words of whatever the source calls it. */
function selectionLine(): string {
  const s = state();
  const catalog = catalogOf(app.target);
  const quantity = catalog ? s.body?.[catalog.fields.quantity] : null;
  const parts = [
    s.transport === "mcp" ? s.tool?.name : s.choice.service?.title,
    s.choice.option?.label,
    quantity ? `${String(quantity)} ${Number(quantity) === 1 ? "unit" : "units"}` : null,
  ].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return s.quote?.doc?.resource?.description || "for this request";
}

function checksSection(
  rows: readonly CheckRow[],
  failing: readonly CheckRow[],
  unchecked: readonly CheckRow[],
): HTMLElement {
  const s = state();
  const open = s.checksOpen || failing.length > 0 || app.mode === "advanced";

  const summary = failing.length
    ? `${failing.length} of ${rows.length} payment checks failed`
    : unchecked.length
      ? `${rows.length - unchecked.length} checks passed, ${unchecked.length} could not be checked`
      : `All ${rows.length} payment checks passed`;

  const strip = el(
    "div",
    { class: `check-strip ${failing.length ? "bad" : unchecked.length ? "warn" : "ok"}` },
    el("span", {}, summary),
    el("div", { class: "grow" }),
    failing.length
      ? null
      : el(
          "button",
          {
            onClick: () => {
              s.checksOpen = !s.checksOpen;
              render();
            },
          },
          open ? "Hide checks" : "View checks",
        ),
  );

  if (!open) return strip;

  const shown = failing.length && app.mode === "guided" ? rows.filter((row) => row.state !== "ok") : rows;
  return el(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "12px" } },
    strip,
    el(
      "div",
      { class: "check-list" },
      ...shown.map((row) =>
        el(
          "div",
          { class: `check-row ${row.state === "fail" ? "failed" : ""}` },
          el("div", { class: `check-mark ${row.state}` }, row.state === "ok" ? "✓" : row.state === "fail" ? "✗" : "?"),
          el(
            "div",
            {},
            el("div", {}, row.label),
            app.mode === "advanced" ? el("div", { class: "detail" }, row.value) : null,
          ),
          el(
            "div",
            { class: "why" },
            row.why,
            row.fix ? el("div", { style: { marginTop: "4px", fontWeight: "500" } }, row.fix) : null,
          ),
        ),
      ),
    ),
  );
}

function guardInput(id: string, key: keyof Guards, placeholder?: string): HTMLInputElement {
  return el("input", {
    id,
    class: "mono",
    placeholder,
    value: app.guards[key],
    onInput: debounce((event: Event) => {
      if (event.target instanceof HTMLInputElement) setGuard(key, event.target.value);
    }),
  });
}

function limitsCard(): HTMLElement {
  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card-head" },
      el("h3", {}, "Your limits"),
      el("div", { class: "grow" }),
      el("span", { class: "help" }, "Kept in this browser, never sent to the endpoint"),
    ),
    el(
      "div",
      { class: "card-body" },
      el(
        "div",
        { class: "field-grid" },
        el(
          "div",
          {},
          el("label", { class: "label", for: "guardMaxSpend" }, "Refuse to pay more than"),
          guardInput("guardMaxSpend", "maxSpend"),
        ),
        el(
          "div",
          {},
          el("label", { class: "label", for: "guardPayTo" }, "Only pay this address"),
          guardInput("guardPayTo", "expectedPayTo", "0x… the recipient you expect"),
        ),
      ),
      el(
        "p",
        { class: "help" },
        "The recipient is the one thing a wrong answer cannot be undone for. Pin it and the lab will refuse a quote that names anyone else.",
      ),
    ),
  );
}

function setGuard(key: keyof Guards, value: string): void {
  app.guards[key] = value.trim();
  app.saveGuards();
  render();
}
