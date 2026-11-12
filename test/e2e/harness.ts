// The end-to-end harness: a real browser, a real page, a stub wallet and the fixture resource.
//
// The stub wallet is what makes the whole payment path testable with no money and no extension.
// It answers the same JSON-RPC the page would send to MetaMask, including the chain reads the
// pre-flight table depends on, so the table under test is the real one rather than a mock of it.
//
// Serves dist/, so run `npm run build` first (`npm run test:e2e` does). Set CHROME_PATH to use a
// Chromium other than the one Playwright installed.

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Browser, chromium, type Page } from "playwright";

import type { App } from "../../src/app.ts";
import type { Report } from "../../src/lib/conformance.ts";
import type { Eip1193Provider } from "../../src/lib/wallet.ts";
import type { PaymentPayload } from "../../src/lib/x402.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const FIXTURE_PORT = Number(process.env.FIXTURE_PORT || 4999);
export const LAB_PORT = Number(process.env.LAB_PORT || 4402);
export const ADDRESS = "0x1111111111111111111111111111111111111111";
export const DEFAULT_SEPARATOR = "0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f";
export const PAY_TO = "0x2222222222222222222222222222222222222222";

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/** Starts a Node script from the repository root and resolves once it prints `ready`. */
export function start(script: string, env: Record<string, string>, ready: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${script} did not start`)), 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (String(chunk).includes(ready)) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("exit", (code) => reject(new Error(`${script} exited ${code}`)));
  });
}

export function startFixture(env: Record<string, string> = {}): Promise<ChildProcess> {
  return start("fixtures/mock-x402.ts", { PORT: String(FIXTURE_PORT), ...env }, "fixture x402 resource");
}

export function startLab(presets = "fixture"): Promise<ChildProcess> {
  return start(
    "server.ts",
    { PORT: String(LAB_PORT), X402_LAB_PRESETS: presets, X402_LAB_ALLOW: `http://127.0.0.1:${FIXTURE_PORT}` },
    "x402 lab on",
  );
}

/** Playwright's own Chromium, or the one CHROME_PATH names. */
export function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.CHROME_PATH;
  return chromium.launch(executablePath ? { executablePath } : {});
}

// ---------------------------------------------------------------------------
// The stub wallet
// ---------------------------------------------------------------------------

export interface WalletCall {
  method: string;
  params?: unknown[] | undefined;
}

export interface SolanaCall {
  method: "connect" | "signTransaction";
  bytes?: number;
}

declare global {
  interface Window {
    __walletCalls?: WalletCall[];
    /** The stub's own request(), kept so a spec can wrap it and then put it back. */
    __stubRequest?: Eip1193Provider["request"];
    __solanaCalls?: SolanaCall[];
    __refuseSign?: boolean;
    __refuseSolanaSign?: boolean;
    __mangleSolanaSign?: boolean;
  }
}

export interface StubWalletOptions {
  address: string;
  domainSeparator: string;
  /** The token balance in atomic units, as a decimal string. */
  balance: string;
  nonceUsed: boolean;
  simulationReverts: boolean;
  secondWallet: boolean;
  solana: boolean;
  solanaAddress: string;
}

export const DEFAULT_WALLET: StubWalletOptions = {
  address: ADDRESS,
  // The separator the fixture's asset really hashes to, so the domain row is a real comparison
  // rather than a rubber stamp.
  domainSeparator: DEFAULT_SEPARATOR,
  balance: "42000000",
  nonceUsed: false,
  simulationReverts: false,
  secondWallet: false,
  solana: false,
  solanaAddress: "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S",
};

/**
 * Installs the stub wallet in the page. It runs in the browser, serialised by Playwright, so it
 * closes over nothing: everything it needs arrives in `options`.
 *
 * Every answer is ABI-encoded the way a node would encode it, because the page decodes it for real:
 * a shortcut here would test the stub rather than the page.
 */
export function installStubWallet(options: StubWalletOptions): void {
  const calls: WalletCall[] = [];
  window.__walletCalls = calls;
  const word = (hex: string): string => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const str = (text: string): string => {
    const bytes = [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `0x${word("20")}${word(text.length.toString(16))}${bytes.padEnd(64, "0")}`;
  };

  const request = async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
    calls.push({ method, params });
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [options.address];
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_call") {
      const call = params?.[0] as { data?: string } | undefined;
      const data = (call?.data ?? "").toLowerCase();
      if (data.startsWith("0x313ce567")) return `0x${word("6")}`;
      if (data.startsWith("0x06fdde03")) return str("USD Coin");
      if (data.startsWith("0x95d89b41")) return str("USDC");
      if (data.startsWith("0x54fd4d50")) return str("2");
      if (data.startsWith("0x3644e515")) return options.domainSeparator;
      if (data.startsWith("0x70a08231")) return `0x${word(BigInt(options.balance).toString(16))}`;
      if (data.startsWith("0xe94a0102")) return `0x${word(options.nonceUsed ? "1" : "0")}`;
      if (data.startsWith("0xe3ee160e")) {
        if (options.simulationReverts) {
          throw Object.assign(new Error("execution reverted: FiatTokenV2: invalid signature"), { code: 3 });
        }
        return "0x";
      }
      return "0x";
    }
    if (method === "eth_signTypedData_v4") return `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
    if (method === "personal_sign") return `0x${"33".repeat(32)}${"44".repeat(32)}1b`;
    if (method === "wallet_switchEthereumChain") return null;
    throw new Error(`the stub wallet has no answer for ${method}`);
  };

  const provider = { isMetaMask: true, on() {}, removeListener() {}, request };
  window.ethereum = provider;
  // Kept so a spec can replace request() to simulate a refusal and then put the real one back.
  window.__stubRequest = request;

  // A one-pixel transparent PNG, so the picker renders a real image element rather than its
  // fallback. EIP-6963 says an icon is a data URI, and the page renders nothing else.
  const icon =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const announced = [{ info: { uuid: "stub-0001", name: "Stub Wallet", rdns: "test.stub", icon }, provider }];
  // A second announced wallet is how the picker gets exercised: with one installed there is
  // nothing to ask, and "whichever extension injected first" is exactly the bug it prevents.
  if (options.secondWallet) {
    announced.push({ info: { uuid: "stub-0002", name: "Other Wallet", rdns: "test.other", icon }, provider });
  }
  window.addEventListener("eip6963:requestProvider", () => {
    for (const entry of announced) {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze(entry) }));
    }
  });

  // A Solana wallet, announced the way they actually are: through the Wallet Standard, with a
  // solana:signTransaction feature that takes raw transaction bytes and returns them signed. The
  // first stub spoke an injected request() API that Phantom answers with "Not implemented", so the
  // suite was green while the real thing was broken. This one is the protocol the wallets use.
  if (!options.solana) return;
  const solanaCalls: SolanaCall[] = [];
  window.__solanaCalls = solanaCalls;
  const account = {
    address: options.solanaAddress,
    publicKey: new Uint8Array(32),
    chains: ["solana:mainnet"],
    features: ["solana:signTransaction"],
  };
  const wallet = {
    version: "1.0.0",
    name: "Stub Solana",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    chains: ["solana:mainnet"],
    accounts: [] as (typeof account)[],
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => {
          solanaCalls.push({ method: "connect" });
          wallet.accounts = [account];
          return { accounts: wallet.accounts };
        },
      },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy"],
        signTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
          solanaCalls.push({ method: "signTransaction", bytes: transaction.length });
          if (window.__refuseSolanaSign) throw new Error("User rejected the request");
          const signed = Uint8Array.from(transaction);
          // The payer's slot, which is the second one. A deterministic 64 bytes: the shape is
          // what the page and the server can check, and the cryptography is the facilitator's.
          if (window.__mangleSolanaSign) {
            const at = 1 + 64 + 64 + 40;
            signed[at] = (signed[at] ?? 0) ^ 0xff;
          }
          signed.fill(9, 65, 129);
          return [{ signedTransaction: signed }];
        },
      },
    },
  };
  const announce = (api: { register(registered: unknown): unknown }): void => {
    try {
      api.register(wallet);
    } catch {
      // A registry that refuses us is not our problem.
    }
  };
  window.addEventListener("wallet-standard:app-ready", (event) => {
    announce((event as CustomEvent<{ register(registered: unknown): unknown }>).detail);
  });
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: announce }));
}

// ---------------------------------------------------------------------------
// Reading the page's state
// ---------------------------------------------------------------------------

/**
 * The parts of the playground's state the specs read or poke. Declared here rather than imported so
 * each field a spec relies on is named in one place; the page keeps it under `app.state.pg`.
 */
export interface PlaygroundReadings {
  body: Record<string, unknown> | null;
  form: unknown;
  payload: PaymentPayload | null | undefined;
  result: unknown;
  firstOrderId?: string;
  choice: { option?: { label: string } };
  cat: { filters: Record<string, string> };
}

export interface ChecksReadings {
  report?: Report | null;
  error?: string | null;
}

/** What a callback run in the page by `inLab` receives. */
export interface Lab {
  app: App;
  pg: PlaygroundReadings;
  checks: ChecksReadings | undefined;
  win: Window;
}

// Evaluated in the page. `app.state` is a bag of per-view objects, so the views a spec reads are
// handed to it already picked out.
const LAB = "{ app: window.x402lab, pg: window.x402lab.state.pg, checks: window.x402lab.state.checks, win: window }";

function call(fn: (lab: Lab, arg: never) => unknown, arg: unknown): string {
  // Playwright serialises a function the same way: the source is its text, which Node has already
  // stripped of types.
  return `(${fn.toString()})(${LAB}, ${JSON.stringify(arg ?? null)})`;
}

/** Runs `read` in the page against the live app state and returns what it returns. */
export function inLab<R, A = null>(page: Page, read: (lab: Lab, arg: A) => R, arg?: A): Promise<Awaited<R>> {
  return page.evaluate<Awaited<R>>(call(read, arg));
}

/** Waits until `test`, run in the page against the live app state, returns something truthy. */
export async function waitInLab<A = null>(
  page: Page,
  test: (lab: Lab, arg: A) => unknown,
  arg?: A,
  options: { timeout?: number } = {},
): Promise<void> {
  await page.waitForFunction(call(test, arg), undefined, options);
}

/** The text of the first match, or "" when it has none. */
export async function text(page: Page, selector: string): Promise<string> {
  return (await page.textContent(selector)) ?? "";
}

/** How many payment authorizations the EVM wallet was asked to sign. */
export function typedSignatures(page: Page): Promise<number> {
  return page.evaluate(() => (window.__walletCalls ?? []).filter((c) => c.method === "eth_signTypedData_v4").length);
}

/** Presses Connect and waits for the stub's account to be on the button. */
export async function connectWallet(page: Page): Promise<void> {
  await page.click("#walletButton");
  await page.waitForFunction(walletConnected);
}

export function walletConnected(): boolean {
  return document.getElementById("walletButton")?.textContent?.includes("0x1111") ?? false;
}

// ---------------------------------------------------------------------------
// One spec
// ---------------------------------------------------------------------------

export interface LabOptions extends Partial<StubWalletOptions> {
  /** A spec that expects the page to log an error says so. */
  allowConsoleErrors?: boolean;
}

export async function withLab(
  name: string,
  run: (context: { page: Page; errors: string[] }) => Promise<void>,
  options: LabOptions = {},
): Promise<void> {
  const { allowConsoleErrors = false, ...wallet } = options;
  const fixture = await startFixture();
  let lab: ChildProcess | null = null;
  let browser: Browser | null = null;
  let failure: unknown = null;
  const errors: string[] = [];

  try {
    lab = await startLab();
    browser = await launchBrowser();
    const page = await browser.newPage();

    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(String(error)));

    await page.addInitScript(installStubWallet, { ...DEFAULT_WALLET, ...wallet });
    await page.goto(`http://localhost:${LAB_PORT}/`);
    // The shell is up once the source badge has been painted from /config.
    await page.waitForSelector("#envBadge:not([hidden])");

    await run({ page, errors });
  } catch (error) {
    failure = error;
  } finally {
    // Always, whatever happened: a spec that leaves a port held makes the next one fail for a
    // reason that has nothing to do with what it was testing.
    await browser?.close().catch(() => {});
    fixture.kill();
    lab?.kill();
  }

  if (failure) {
    console.error(`FAIL ${name}: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`);
    process.exitCode = 1;
    return;
  }
  if (errors.length && !allowConsoleErrors) {
    console.error(`FAIL ${name}: the page logged errors:\n  ${errors.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok   ${name}`);
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
