// Wallets, and everything this tool reads from a chain.
//
// The key never leaves the extension: an EIP-3009 authorization is an EIP-712 typed-data
// signature, which every browser wallet can produce, so the whole x402 handshake works with
// nothing for this process to leak.
//
// Providers are discovered with EIP-6963 rather than by grabbing `window.ethereum`. With two
// extensions installed, `window.ethereum` is whichever one won the race to inject, and a tool that
// pays from "whichever wallet got there first" is a tool that pays from the wrong account.

import {
  callData,
  decodeString,
  decodeUint,
  encodeAddress,
  encodeBytes32,
  encodeTransferWithAuthorization,
  type Hex,
  SELECTORS,
  type TransferAuthorization,
  type TransferWithAuthorizationTypedData,
} from "./abi.ts";
import { errorMessage, isRecord } from "./json.ts";

// ---------------------------------------------------------------------------
// EIP-1193 and EIP-6963
// ---------------------------------------------------------------------------

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon?: string;
  rdns: string;
}

export interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<Eip6963ProviderDetail>;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export function discoverEvmProviders({ timeoutMs = 300 } = {}): Promise<Eip6963ProviderDetail[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Eip6963ProviderDetail>();
    const onAnnounce = (event: CustomEvent<Eip6963ProviderDetail>) => {
      const detail = event.detail;
      if (detail?.info?.uuid) found.set(detail.info.uuid, { info: detail.info, provider: detail.provider });
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const list = [...found.values()];
      // A wallet that predates EIP-6963 announces nothing, and is still a wallet.
      if (!list.length && window.ethereum) {
        list.push({ info: { uuid: "legacy", name: "Injected wallet", rdns: "legacy" }, provider: window.ethereum });
      }
      resolve(list);
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// An EVM wallet, and the reads that make the pre-flight table worth having
// ---------------------------------------------------------------------------

export interface TokenFacts {
  decimals: number | null;
  name: string | null;
  symbol: string | null;
  version: string | null;
  domainSeparator: string | null;
}

export type Simulation = { state: "ok"; detail?: string } | { state: "fail"; detail: string };

export interface EvmWallet {
  provider: Eip1193Provider;
  connect(): Promise<{ address: string; chainId: number }>;
  chainId(): Promise<number>;
  switchChain(chainId: number): Promise<boolean>;
  readToken(asset: string): Promise<TokenFacts>;
  balanceOf(asset: string, address: string): Promise<string | null>;
  authorizationState(asset: string, from: string, nonce: string): Promise<boolean | null>;
  signTypedData(address: string, typed: TransferWithAuthorizationTypedData): Promise<string>;
  personalSign(address: string, message: string): Promise<string>;
  simulateSettlement(args: {
    asset: string;
    authorization: TransferAuthorization;
    signature: string;
    from: string;
  }): Promise<Simulation>;
}

function hexChainId(value: unknown): number {
  return Number.parseInt(String(value), 16);
}

export function createEvmWallet(provider: Eip1193Provider): EvmWallet {
  const request = (method: string, params: unknown[]) => provider.request({ method, params });

  async function ethCall(to: string, data: Hex, from?: string): Promise<unknown> {
    const call: Record<string, string> = { to, data };
    if (from) call.from = from;
    return request("eth_call", [call, "latest"]);
  }

  return {
    provider,
    async connect() {
      const accounts = await request("eth_requestAccounts", []);
      const address = Array.isArray(accounts) ? accounts[0] : undefined;
      if (typeof address !== "string") throw new Error("the wallet connected without naming an account");
      return { address, chainId: hexChainId(await request("eth_chainId", [])) };
    },
    async chainId() {
      return hexChainId(await request("eth_chainId", []));
    },
    // switchChain asks the wallet to move rather than telling the user to. A blocked pay button
    // that says "wrong chain" and cannot fix it is a dead end the wallet is happy to resolve.
    async switchChain(chainId) {
      try {
        await request("wallet_switchEthereumChain", [{ chainId: `0x${chainId.toString(16)}` }]);
        return true;
      } catch (error) {
        // 4902: the wallet does not know this chain. Adding it needs RPC details this tool does
        // not have and should not invent, so the honest answer is to say so.
        if (isRecord(error) && error.code === 4902) {
          throw new Error(`your wallet does not have chain ${chainId} configured; add it there first`);
        }
        throw error;
      }
    },

    // readToken gathers what the pre-flight table needs to judge a quote's asset and domain. Each
    // read is independent: a token that implements some of these and not others still yields the
    // rows it can support, and the ones it cannot are reported unchecked rather than assumed.
    async readToken(asset) {
      const read = async <T>(data: Hex, decode: (raw: unknown) => T | null): Promise<T | null> => {
        try {
          return decode(await ethCall(asset, data));
        } catch {
          return null;
        }
      };
      const decimals = await read(SELECTORS.decimals, (raw) => {
        const value = decodeUint(raw);
        return value === null ? null : Number(value);
      });
      return {
        decimals: decimals !== null && Number.isFinite(decimals) ? decimals : null,
        name: await read(SELECTORS.name, decodeString),
        symbol: await read(SELECTORS.symbol, decodeString),
        version: await read(SELECTORS.version, decodeString),
        domainSeparator: await read(SELECTORS.domainSeparator, (raw) =>
          typeof raw === "string" && raw !== "0x" ? raw : null,
        ),
      };
    },

    async balanceOf(asset, address) {
      const value = decodeUint(await ethCall(asset, callData(SELECTORS.balanceOf, encodeAddress(address))));
      return value === null ? null : value.toString();
    },

    // authorizationState answers the replay question before signing: an EIP-3009 nonce is
    // single-use at the contract level, so a used one produces a signature that can never settle.
    async authorizationState(asset, from, nonce) {
      try {
        const raw = await ethCall(
          asset,
          callData(SELECTORS.authorizationState, encodeAddress(from), encodeBytes32(nonce)),
        );
        const value = decodeUint(raw);
        return value === null ? null : value !== 0n;
      } catch {
        return null;
      }
    },

    async signTypedData(address, typed) {
      return String(await request("eth_signTypedData_v4", [address, JSON.stringify(typed)]));
    },

    // personalSign sends hex-encoded UTF-8 rather than a plain string: the server hashes BYTES per
    // ERC-191, and a plain string is ambiguous in some wallets.
    async personalSign(address, message) {
      const hex = `0x${[...new TextEncoder().encode(message)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      return String(await request("personal_sign", [hex, address]));
    },

    // simulate runs the exact call the facilitator will make, as an eth_call, and reports whether
    // the token would accept it. This is the strongest thing that can be known before anything is
    // sent: it catches a wrong EIP-712 domain, a spent nonce, a short balance and a clock problem,
    // all of which otherwise surface as a refusal with a payment already in flight.
    async simulateSettlement({ asset, authorization, signature, from }) {
      const data = encodeTransferWithAuthorization({ authorization, signature });
      try {
        // `from` is the caller the facilitator would use. transferWithAuthorization is
        // permissionless, so any address simulates the same result; the payer's own address is
        // used because it certainly exists.
        await ethCall(asset, data, from);
        return { state: "ok" };
      } catch (error) {
        const data = isRecord(error) && isRecord(error.data) ? error.data.message : undefined;
        return { state: "fail", detail: readRevert(typeof data === "string" ? data : errorMessage(error)) };
      }
    },
  };
}

/**
 * readRevert turns a wallet's error into the sentence the token meant. The strings below are
 * FiatToken's own revert reasons, which are what a USDC-family token answers with, and saying
 * "invalid signature" out loud is the difference between a five minute fix and an afternoon.
 */
function readRevert(message: string): string {
  if (/invalid signature|ECRecover/i.test(message)) {
    return "the token rejects the signature: usually the EIP-712 domain in the quote is not the one the token reports";
  }
  if (/authorization is used|nonce/i.test(message)) return "this authorization nonce has already been used";
  if (/not yet valid/i.test(message)) return "validAfter is in the future for the chain's clock";
  if (/expired/i.test(message)) return "the authorization has expired";
  if (/transfer amount exceeds balance|insufficient/i.test(message)) {
    return "the payer's balance does not cover the amount";
  }
  return message.slice(0, 300);
}
