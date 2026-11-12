// What the checks are checked against.
//
// facts() is the one place the quote, the wallet reads and your own limits are brought together,
// so the pre-flight table and the pay button can never be looking at different numbers.

import { app } from "../../app.ts";
import { walletAuthOf } from "../../lib/agent.ts";
import type { Facts } from "../../lib/checks.ts";
import { mintUnit } from "../../lib/solana.ts";
import { railOf } from "../../lib/x402.ts";
import { state } from "./state.ts";

/**
 * Reads from the chain what the checks are judged against. Each read is independent and failure
 * tolerant: what cannot be read is reported as unchecked, never assumed.
 */
export async function gatherFacts(): Promise<void> {
  const s = state();
  s.token = {};
  s.balance = null;
  s.nonceUsed = null;
  const requirement = s.requirement;
  if (!requirement) return;
  if (railOf(requirement) === "solana") {
    // No RPC on this rail, so the unit comes from this tool's own table or from the quote. Absent
    // both, s.token stays empty and the decimals check refuses the quote rather than assuming six.
    const unit = mintUnit(requirement.asset, requirement.extra);
    if (unit) s.token = { decimals: unit.decimals, symbol: unit.symbol };
    return;
  }
  const wallet = app.wallet;
  const asset = requirement.asset;
  if (railOf(requirement) !== "evm" || !wallet || !asset) return;
  try {
    s.token = await wallet.client.readToken(asset);
  } catch {
    s.token = {};
  }
  try {
    s.balance = await wallet.client.balanceOf(asset, wallet.address);
  } catch {
    s.balance = null;
  }
}

export function facts(): Facts {
  const s = state();
  const network = s.requirement?.network;
  return {
    requirement: s.requirement,
    doc: s.quote?.doc ?? s.mcpDoc,
    parity: s.quote?.parity,
    wallet: app.wallet ? { address: app.wallet.address, chainId: app.wallet.chainId, balanceAtomic: s.balance } : {},
    token: s.token,
    guards: app.guards,
    // What the preset expects to be paid on this network, which is what the payTo row compares
    // against when nothing has been pinned by hand.
    knownPayTo: (network && app.target?.knownPayTo?.[network]) || "",
    nonceUsed: s.nonceUsed,
    simulation: s.simulation,
    // What this endpoint itself holds for you, so a check about the wallet's on-chain balance can
    // stop advising a top-up when the money is already here.
    endpoint: {
      spendableBalance: walletAuthOf(app.target) !== null || app.agentToken !== null,
      balanceUSD: app.agentBalance,
    },
  };
}
