// Talking to a Solana wallet.
//
// Through the Wallet Standard, which is the protocol Phantom, Solflare and Backpack all register
// with: a wallet announces itself with an event and exposes named features, and the one this needs
// is `solana:signTransaction`, which takes RAW TRANSACTION BYTES and returns the signed bytes.
// Bytes are exactly what this tool has, so nothing here needs @solana/web3.js.
//
// The injected-object path is kept as a fallback, because a wallet that has not adopted the
// standard still has it, and because a wrong answer from it cannot go anywhere: paySolana compares
// the bytes that come back against the message it built and refuses anything else.

const FEATURE = {
  connect: "standard:connect",
  signTransaction: "solana:signTransaction",
} as const;

interface StandardAccount {
  address: string;
}

interface StandardConnectFeature {
  connect(): Promise<{ accounts?: StandardAccount[] }>;
}

interface StandardSignTransactionFeature {
  signTransaction(input: {
    account: StandardAccount | null;
    transaction: Uint8Array;
  }): Promise<Array<{ signedTransaction?: Uint8Array }>>;
}

interface StandardWallet {
  name: string;
  icon?: string;
  chains?: readonly string[];
  features: {
    [FEATURE.connect]?: StandardConnectFeature;
    [FEATURE.signTransaction]?: StandardSignTransactionFeature;
    [feature: string]: unknown;
  };
}

/** The injected object a pre-standard wallet exposes. Only the members this page touches. */
interface InjectedSolanaProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey?: { toString(): string } } | undefined>;
  signTransaction?(transaction: {
    serialize(): Uint8Array;
    serializeMessage(): Uint8Array;
  }): Promise<{ serialize?(): Uint8Array } | Uint8Array | string | undefined>;
}

interface StandardRegistration {
  register(...wallets: StandardWallet[]): () => void;
}

declare global {
  interface Window {
    phantom?: { solana?: InjectedSolanaProvider };
    solflare?: InjectedSolanaProvider;
    backpack?: InjectedSolanaProvider;
    solana?: InjectedSolanaProvider;
  }
  interface WindowEventMap {
    "wallet-standard:register-wallet": CustomEvent<(api: StandardRegistration) => void>;
  }
}

// The Wallet Standard's registration handshake, run once at module load so it is listening before
// any wallet dispatches. Wallets that loaded first answer the app-ready event; wallets that load
// later announce themselves with register-wallet.
const registered: StandardWallet[] = [];
if (typeof window !== "undefined") {
  const api: StandardRegistration = {
    register: (...wallets) => {
      registered.push(...wallets);
      return () => {};
    },
  };
  window.addEventListener("wallet-standard:register-wallet", ({ detail }) => {
    try {
      detail(api);
    } catch {
      // A wallet that throws while registering is a wallet this page does without.
    }
  });
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
}

// The injected objects, for wallets that never adopted the standard. `window.solana` comes last
// because it is whichever extension won the race to claim it.
const INJECTED: ReadonlyArray<{ key: string; name: string; get(): InjectedSolanaProvider | undefined }> = [
  { key: "phantom", name: "Phantom", get: () => window.phantom?.solana },
  { key: "solflare", name: "Solflare", get: () => window.solflare },
  { key: "backpack", name: "Backpack", get: () => window.backpack },
  { key: "solana", name: "Solana wallet", get: () => window.solana },
];

export interface SolanaWalletEntry {
  key: string;
  name: string;
  icon?: string | undefined;
  wallet?: StandardWallet;
  provider?: InjectedSolanaProvider;
}

/**
 * discoverSolanaWallets returns what is installed, standard wallets first and deduplicated by name:
 * one wallet that both registers and injects is one wallet, and offering it twice is how a picker
 * ends up asking which of two identical things you meant.
 */
export function discoverSolanaWallets(): SolanaWalletEntry[] {
  const found: SolanaWalletEntry[] = [];
  const names = new Set<string>();

  for (const wallet of registered) {
    if (!wallet.features[FEATURE.signTransaction] || !wallet.features[FEATURE.connect]) continue;
    // Solana wallets register under "solana:*" chains. A registered wallet for another chain
    // entirely (the standard is not Solana's alone) has no business in this list.
    if (!(wallet.chains ?? []).some((chain) => chain.startsWith("solana:"))) continue;
    if (names.has(wallet.name)) continue;
    names.add(wallet.name);
    found.push({ key: wallet.name, name: wallet.name, icon: wallet.icon, wallet });
  }

  const seen = new Set<InjectedSolanaProvider>();
  for (const entry of INJECTED) {
    let provider: InjectedSolanaProvider | undefined;
    try {
      provider = entry.get();
    } catch {
      // A getter that throws is an extension mid-injection, not a wallet.
      continue;
    }
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    const name = provider.isPhantom
      ? "Phantom"
      : provider.isSolflare
        ? "Solflare"
        : provider.isBackpack
          ? "Backpack"
          : entry.name;
    if (names.has(name)) continue;
    names.add(name);
    found.push({ key: entry.key, name, provider });
  }
  return found;
}

export interface SolanaWallet {
  connect(): Promise<{ address: string }>;
  signTransaction(unsigned: Uint8Array): Promise<Uint8Array>;
}

export function createSolanaWallet(entry: SolanaWalletEntry): SolanaWallet {
  const { wallet, provider } = entry;
  let account: StandardAccount | null = null;

  return {
    async connect() {
      const connectFeature = wallet?.features[FEATURE.connect];
      if (connectFeature) {
        const { accounts } = await connectFeature.connect();
        account = accounts?.[0] ?? null;
        if (!account?.address) throw new Error("the wallet connected without telling us which account");
        return { address: account.address };
      }
      if (!provider) throw new Error("this entry is neither a standard wallet nor an injected one");
      const answer = await provider.connect();
      // An injected wallet returns { publicKey } or sets it on itself, and a publicKey is an object
      // with a toString rather than a string.
      const address = (answer?.publicKey ?? provider.publicKey)?.toString() ?? "";
      if (!address) throw new Error("the wallet connected without telling us which account");
      return { address };
    },

    // signTransaction hands over the serialized transaction, signature slots and all, and gets the
    // same transaction back with this wallet's slot filled. The wallet decodes those bytes itself
    // and shows what they do, which is the prompt the payer actually reads.
    async signTransaction(unsigned) {
      const signFeature = wallet?.features[FEATURE.signTransaction];
      if (signFeature) {
        const [result] = await signFeature.signTransaction({ account, transaction: unsigned });
        const signed = result?.signedTransaction;
        if (!signed) throw new Error("the wallet returned no signed transaction");
        return new Uint8Array(signed);
      }

      // The injected fallback. Phantom's own signTransaction takes a web3.js Transaction, which is
      // a dependency this tool does not have, so what goes over is the smallest object that walks
      // and quacks like one. Whatever comes back is checked against the message we built before it
      // is sent anywhere, so a wallet that mangles this cannot spend anything.
      if (typeof provider?.signTransaction !== "function") {
        throw new Error("this wallet exposes neither the Wallet Standard's solana:signTransaction nor an injected one");
      }
      const answer = await provider.signTransaction({
        serialize: () => unsigned,
        serializeMessage: () => unsigned.slice(1 + 64 + 64),
      });
      const signed = answer instanceof Uint8Array ? answer : typeof answer === "object" ? answer.serialize?.() : null;
      if (!signed) throw new Error("the wallet returned no signed transaction bytes");
      return new Uint8Array(signed);
    },
  };
}
