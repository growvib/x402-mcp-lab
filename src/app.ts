// The shell: one source, one wallet, one run, five views.
//
// Everything that reaches the outside world goes through `http`, and everything it learns is
// appended to the current run. When a payment goes somewhere unexpected the question is always
// "what exactly was sent", and the answer has to be in the page rather than in a console somebody
// cleared.
//
// The rail holds navigation and nothing else. Where the requests go is a property of the SOURCE,
// which lives in its own drawer; what you are willing to pay is a property of the PAYMENT, and
// lives next to the payment. Settings that decide whether money moves do not belong in a nav list.

import { signIn, walletAuthOf } from "./lib/agent.ts";
import type { CheckRow } from "./lib/checks.ts";
import { createPaymentGate, environmentLabel } from "./lib/guard.ts";
import { asRecord, errorMessage, isRecord } from "./lib/json.ts";
import { chooseOne } from "./lib/modal.ts";
import { networkMark } from "./lib/netmark.ts";
import { createSolanaWallet, discoverSolanaWallets, type SolanaWallet } from "./lib/solana-wallet.ts";
import {
  forgetToken,
  loadGuards,
  loadToken,
  saveGuards as persistGuards,
  type Run,
  type RunEntry,
  saveRun,
  saveToken,
} from "./lib/store.ts";
import type { Guards, HttpRequest, HttpResponse, LabConfig, Preset, Target } from "./lib/types.ts";
import { targetFromPreset } from "./lib/types.ts";
import { byId, el, mount, svgEl, withViewTransition } from "./lib/ui.ts";
import { createEvmWallet, discoverEvmProviders, type Eip6963ProviderDetail, type EvmWallet } from "./lib/wallet.ts";
import { renderChecks } from "./views/checks.ts";
import { renderHistory } from "./views/history.ts";
import { renderLearn } from "./views/learn.ts";
import { renderOrders } from "./views/orders.ts";
import { renderPlayground } from "./views/playground.ts";
import { renderSource } from "./views/source.ts";

const VIEWS = {
  playground: renderPlayground,
  learn: renderLearn,
  checks: renderChecks,
  orders: renderOrders,
  history: renderHistory,
} satisfies Record<string, () => Node>;

export type Route = keyof typeof VIEWS;
export type Mode = "guided" | "advanced";

export interface EvmConnection {
  kind: "evm";
  client: EvmWallet;
  address: string;
  chainId: number;
  label: string;
}

export interface SolanaConnection {
  client: SolanaWallet;
  address: string;
  label: string;
}

export interface App {
  config: LabConfig;
  target: Target | null;
  guards: Guards;
  wallet: EvmConnection | null;
  agentToken: string | null;
  /**
   * What the endpoint last told us this account holds. Reported by the server rather than tracked
   * here: a balance this page computed would be a second opinion about money, which is the one
   * thing there should never be two of.
   */
  agentBalance: number | null;
  agentTokenExpiresAt: string | null;
  /**
   * The authority the last sign-in message named. Kept so the page can explain a wallet's domain
   * warning, and only when there is one to explain.
   */
  signInAuthority: string | null;
  /**
   * A Solana wallet, kept beside the EVM one rather than replacing it: a quote offers both rails
   * and somebody comparing them should not have to disconnect one to look at the other.
   */
  solana: SolanaConnection | null;
  run: Run | null;
  /** Each view's own state, by name. Cleared whenever the source changes. See `defineViewState`. */
  state: Record<string, object>;
  route: Route | null;
  mode: Mode;
  saveGuards(): void;
}

declare global {
  interface Window {
    /** The live state, exposed on purpose for the console and the end-to-end tests. */
    x402lab?: App;
  }
}

export const gate = createPaymentGate();

export const app: App = {
  config: { token: "", presets: [], allowedOrigins: [] },
  target: null,
  guards: { maxSpend: "1.00", expectedPayTo: "" },
  wallet: null,
  agentToken: null,
  agentBalance: null,
  agentTokenExpiresAt: null,
  signInAuthority: null,
  solana: null,
  run: null,
  state: {},
  route: "playground",
  mode: "guided",
  saveGuards() {
    persistGuards(targetKey(), app.guards);
  },
};

/**
 * Declares a view's state and returns its accessor. The state lives under `app.state[name]`, is
 * created on first read and is dropped with every other view's when the source changes, so a view
 * can never show what it learned about the previous source.
 */
export function defineViewState<T extends object>(name: string, init: () => T): () => T {
  // The cast is sound as long as each name is declared once, which is what this function is for.
  return () => {
    const existing = app.state[name];
    if (existing) return existing as T;
    const created = init();
    app.state[name] = created;
    return created;
  };
}

/** The current source. Every view renders under one: boot selects the first preset before routing. */
export function currentTarget(): Target {
  if (!app.target) throw new Error("no source is selected");
  return app.target;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const ABSOLUTE = /^https?:\/\//i;

export function url(pathOrUrl: string): string {
  if (ABSOLUTE.test(pathOrUrl)) return pathOrUrl;
  const origin = currentTarget().origin.replace(/\/+$/, "");
  return origin + (pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`);
}

function envelope(raw: unknown): HttpResponse {
  const record = asRecord(raw);
  const headers: Record<string, string> = {};
  if (isRecord(record.headers)) {
    for (const [name, value] of Object.entries(record.headers)) headers[name] = String(value);
  }
  return {
    status: typeof record.status === "number" ? record.status : 0,
    headers,
    body: typeof record.body === "string" ? record.body : "",
    ...(typeof record.ms === "number" ? { ms: record.ms } : {}),
    ...(typeof record.transportError === "string" ? { transportError: record.transportError } : {}),
  };
}

/**
 * Forwards through the local proxy, which is the only way a browser can read a cross-origin 402 and
 * its headers. The envelope it returns is the same one the headless runner produces, so the
 * conformance suite cannot tell which it is running under.
 *
 * It never retries. A retry on a paying request is a second payment, and a retry on a quote is a
 * second load on somebody's endpoint that nobody asked for.
 */
export async function http({
  method = "GET",
  url: target,
  path,
  headers = {},
  body,
  note,
}: HttpRequest): Promise<HttpResponse> {
  const absolute = url(target ?? path ?? "/");
  const started = Date.now();
  let answer: HttpResponse;
  try {
    const res = await fetch("/proxy", {
      method: "POST",
      headers: { "content-type": "application/json", "x-x402-lab": app.config.token },
      body: JSON.stringify({ method, url: absolute, headers, body }),
    });
    const parsed: unknown = await res.json();
    // A 403 is the local proxy refusing the request (an origin outside the allowlist), not the
    // upstream answering: there was no answer to show.
    answer =
      res.status === 403
        ? { status: 0, headers: {}, body: "", transportError: String(asRecord(parsed).error ?? "refused by the proxy") }
        : envelope(parsed);
  } catch (error) {
    answer = { status: 0, headers: {}, body: "", transportError: errorMessage(error) };
  }
  answer.ms ??= Date.now() - started;

  record({
    method,
    url: absolute,
    status: answer.transportError ? "transport error" : answer.status,
    ms: answer.ms,
    note: note ?? answer.transportError,
    request: body,
    response: answer.body,
    headers: answer.headers,
    at: new Date().toISOString(),
  });
  return answer;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export function startRun(): Run {
  app.run = {
    id: crypto.randomUUID().slice(0, 6),
    target: app.target ? url(app.target.resource) : "",
    startedAt: new Date().toISOString(),
    entries: [],
    checks: [],
  };
  return app.run;
}

export function record(entry: RunEntry): void {
  const run = app.run ?? startRun();
  run.entries.push(entry);
  saveRun(run);
}

export function recordChecks(rows: CheckRow[]): void {
  const run = app.run ?? startRun();
  run.checks = rows;
  saveRun(run);
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export function targetKey(): string {
  return app.target ? `${app.target.origin}${app.target.resource}` : "none";
}

export function setTarget(preset: Preset): void {
  app.target = targetFromPreset(preset);
  app.guards = loadGuards(targetKey());
  app.agentToken = loadToken(targetKey());
  // The balance belongs to the account on the source that was just left behind.
  app.agentBalance = null;
  app.agentTokenExpiresAt = null;
  app.signInAuthority = null;
  app.state = {};
  startRun();
  paintChrome();
  render();
}

export function updateTarget(patch: Partial<Target>): void {
  Object.assign(currentTarget(), patch);
  app.state = {};
  startRun();
  paintChrome();
  render();
}

function paintChrome(): void {
  const label = environmentLabel(app.target);
  const badge = byId("envBadge");
  badge.hidden = false;
  badge.className = `pill ${label.kind}`;
  badge.textContent = label.text;
  badge.title = label.detail;
  byId("sourceLabel").textContent = app.target?.name || "Source";
  paintBalance();
}

/**
 * The balance this endpoint holds, in the top bar beside the wallet, because that is where a person
 * looks for a balance.
 *
 * Three states. A balance cannot be read without proving the wallet, so before that is done the
 * badge does not hide; it offers the sign-in that would reveal one, and pressing it is the whole
 * action.
 */
export function paintBalance(): void {
  const badge = document.getElementById("balanceBadge");
  if (!(badge instanceof HTMLButtonElement)) return;
  const known = app.agentToken !== null && app.agentBalance !== null;
  const offered = walletAuthOf(app.target) !== null;

  badge.hidden = !known && !(offered && app.wallet);
  badge.classList.toggle("ok", known);
  badge.disabled = signInState.busy;
  if (badge.hidden) return;

  if (signInState.busy) {
    badge.textContent = "Reading your balance...";
    badge.title = "Your wallet is being asked to sign a sign-in message. It moves no funds.";
    return;
  }
  if (known) {
    badge.textContent = `$${app.agentBalance} balance`;
    badge.title = `Spendable on ${app.target?.name || "this endpoint"} without a new payment. Press to read it again.`;
    return;
  }
  badge.textContent = signInState.error ? "Balance unread, retry" : "Show my balance";
  badge.title = signInState.error
    ? `${signInState.error} Press to ask again.`
    : "One signature proves which wallet is asking. It moves no funds and touches no chain.";
}

export interface NetworkInfo {
  network: string;
  label: string;
  /** How many networks the current quote offers. */
  count: number;
  onPick: () => void;
}

// A quote can offer more than one network, and which one is selected changes what is signed, what
// it is signed with and where the money goes. That is the state of the session, so it sits in the
// chrome beside the wallet. It is pushed here by the step that owns the rails rather than read from
// it, because the chrome does not know what a rail is and should not learn.
let onPickNetwork: (() => void) | null = null;

export function paintNetwork(info: NetworkInfo | null): void {
  const button = document.getElementById("networkButton");
  if (!(button instanceof HTMLButtonElement)) return;
  onPickNetwork = info?.onPick ?? null;
  button.hidden = !info;
  if (!info) return;

  const choosable = info.count > 1;
  mount(
    button,
    networkMark(info.network, { label: info.label }),
    el("span", {}, info.label),
    // The affordance only exists when there is something to choose between.
    choosable
      ? svgEl(
          "svg",
          {
            class: "caret",
            width: "12",
            height: "12",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-width": "2",
            "aria-hidden": "true",
          },
          svgEl("path", { d: "M6 9l6 6 6-6" }),
        )
      : null,
  );
  button.disabled = !choosable;
  button.title = choosable
    ? `${info.label} (${info.network}). This quote offers ${info.count} networks: press to switch.`
    : `${info.label} (${info.network})`;
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

const NOT_GUESSING = "This page never guesses: paying from the wrong account is not a recoverable mistake.";

export async function connectWallet(): Promise<void> {
  const button = byId("walletButton");
  const providers = await discoverEvmProviders();
  if (!providers.length) {
    button.textContent = "No wallet found";
    button.title = "No browser wallet announced itself. Install one, or open this page in a profile that has one.";
    return;
  }

  // With more than one installed, ASK. `window.ethereum` is whichever extension won the race to
  // inject, and paying from the wrong account is not a recoverable mistake.
  const chosen = providers.length === 1 ? providers[0] : await pickWallet(providers);
  // Backing out of the picker leaves the page exactly as it was.
  if (!chosen) return;

  const previous = button.textContent;
  button.textContent = "Connecting...";
  const client = createEvmWallet(chosen.provider);
  let account: { address: string; chainId: number };
  try {
    account = await client.connect();
  } catch (error) {
    // A rejected connection is the most common outcome of this button and is not a failure worth
    // shouting about: the wallet stays unconnected and the label says so.
    button.textContent = previous;
    button.title = errorMessage(error);
    return;
  }

  const { address, chainId } = account;
  app.wallet = { kind: "evm", client, address, chainId, label: chosen.info.name };
  button.textContent = `${address.slice(0, 6)}…${address.slice(-4)}`;
  button.title = `${chosen.info.name} on chain ${chainId}`;

  chosen.provider.on?.("accountsChanged", () => location.reload());
  chosen.provider.on?.("chainChanged", () => location.reload());
  render();
  paintBalance();

  // Read the balance now, not when somebody goes looking for it. Connecting a wallet to a source
  // that publishes a sign-in is already the decision to say which wallet this is, and the message
  // moves no funds. A refused signature leaves the badge offering it again.
  if (walletAuthOf(app.target) && !app.agentToken) await signInWithWallet({ quiet: true });
}

export type SolanaConnectResult = { address: string } | { error: string | null; cancelled?: boolean };

/**
 * Connects a Solana wallet, which is a different set of extensions and a different object to talk
 * to. Offered from the payment step rather than the top bar, because it is only needed when a quote
 * turns out to have a Solana rail on it.
 */
export async function connectSolanaWallet(): Promise<SolanaConnectResult> {
  const wallets = discoverSolanaWallets();
  if (!wallets.length) {
    return { error: "No Solana wallet announced itself. Phantom, Solflare and Backpack are the ones this looks for." };
  }

  const chosen =
    wallets.length === 1
      ? wallets[0]
      : (
          await chooseOne({
            title: "Which Solana wallet should pay?",
            note: `More than one is installed. ${NOT_GUESSING}`,
            items: wallets.map((entry) => ({
              value: entry,
              label: entry.name,
              sub: entry.wallet ? "wallet standard" : "injected",
              iconUrl: entry.icon,
            })),
            cancelLabel: "Not now",
          })
        )?.value;
  if (!chosen) return { error: null, cancelled: true };

  try {
    // The whole entry, not just a provider: a Wallet Standard wallet is signed through its own
    // feature object and has no injected provider at all.
    const client = createSolanaWallet(chosen);
    const { address } = await client.connect();
    app.solana = { client, address, label: chosen.name };
    render();
    return { address };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function pickWallet(providers: Eip6963ProviderDetail[]): Promise<Eip6963ProviderDetail | null> {
  const choice = await chooseOne({
    title: "Which wallet should pay?",
    note: `More than one wallet is installed. ${NOT_GUESSING}`,
    items: providers.map((entry) => ({
      value: entry,
      label: entry.info.name,
      sub: entry.info.rdns,
      iconUrl: entry.info.icon,
    })),
    cancelLabel: "Not now",
  });
  return choice?.value ?? null;
}

/**
 * Signing in is offered from several places: the Source drawer, the balance badge, the Orders page
 * and the review step. One action, so they cannot drift, and it keeps its own in-flight and error
 * state rather than making each caller invent one.
 */
export const signInState: { busy: boolean; error: string | null; quiet: boolean } = {
  busy: false,
  error: null,
  quiet: false,
};

function paintSignIn(): void {
  render();
  paintSource();
  paintBalance();
}

export async function signInWithWallet({ quiet = false }: { quiet?: boolean } = {}): Promise<boolean> {
  if (signInState.busy) return false;
  const wallet = app.wallet;
  if (!wallet) {
    signInState.error = "Connect a wallet first: the sign-in proves which wallet is asking.";
    paintSignIn();
    return false;
  }

  signInState.busy = true;
  signInState.error = null;
  signInState.quiet = false;
  paintSignIn();

  const result = await signIn({
    http,
    target: app.target,
    address: wallet.address,
    sign: (message) => wallet.client.personalSign(wallet.address, message),
    // Fires while the wallet dialog is opening, so a domain warning is explained on the page at the
    // moment the wallet gives it rather than pre-emptively on every sign-in that will not get one.
    onChallenge: ({ authority }) => {
      app.signInAuthority = authority || null;
      render();
    },
  });

  signInState.busy = false;
  if (result.error === null) {
    signInState.error = null;
    rememberAgentToken(result.token, { balance: result.balance, expiresAt: result.expiresAt });
  } else {
    // A signature somebody declined is not a failure to report in red: the automatic attempt on
    // connect asked without being told to, and refusing it is a reasonable answer. The badge still
    // carries the reason, and pressing it asks again.
    signInState.error = result.error;
    signInState.quiet = quiet;
  }
  paintSignIn();
  return result.error === null;
}

export function rememberAgentToken(
  token: string,
  { balance, expiresAt }: { balance?: number | null; expiresAt?: string | null } = {},
): void {
  if (!token) return;
  app.agentToken = token;
  // Every order returns a fresh token and the balance it left behind, so the screen never has to go
  // and ask.
  if (balance !== undefined) app.agentBalance = balance;
  if (expiresAt !== undefined) app.agentTokenExpiresAt = expiresAt;
  saveToken(targetKey(), token);
  paintBalance();
}

/**
 * For the places that learn a balance without learning a token: the 402 an endpoint answers when
 * the balance is short carries one.
 */
export function rememberBalance(balance: number | null): void {
  if (balance === null) return;
  app.agentBalance = balance;
  paintBalance();
}

export function dropAgentToken(): void {
  app.agentToken = null;
  app.agentBalance = null;
  app.agentTokenExpiresAt = null;
  forgetToken(targetKey());
  paintBalance();
  render();
}

// ---------------------------------------------------------------------------
// Routing and chrome
// ---------------------------------------------------------------------------

function isRoute(value: string): value is Route {
  return Object.hasOwn(VIEWS, value);
}

export function render(): void {
  // Cleared before the view is mounted, so a step that has no network to show does not inherit the
  // last one that did. The step that has one sets it again on its way past.
  paintNetwork(null);
  for (const nav of document.querySelectorAll<HTMLElement>(".nav")) {
    const current = nav.dataset.route === app.route;
    nav.classList.toggle("on", current);
    if (current) nav.setAttribute("aria-current", "page");
    else nav.removeAttribute("aria-current");
  }
  const view = byId("view");
  try {
    mount(view, VIEWS[app.route ?? "playground"]());
  } catch (error) {
    // A view that throws shows its stack in place, rather than leaving the last view on screen
    // looking current.
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    mount(
      view,
      el("div", { class: "page" }, el("div", { class: "callout bad" }, el("div", { class: "callout-body" }, detail))),
    );
  }
}

export function paintSource(): void {
  mount(byId("sourceBody"), renderSource());
}

function route(): void {
  const asked = location.hash.replace(/^#/, "");
  const next: Route = isRoute(asked) ? asked : "playground";
  if (app.route === next) return;
  withViewTransition(() => {
    app.route = next;
    render();
  });
}

type Theme = "light" | "dark";

function applyTheme(theme: string | null): void {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function storedPreference(key: string): string | null {
  try {
    return localStorage.getItem(`x402-lab:${key}`);
  } catch {
    // A private window: the defaults are fine.
    return null;
  }
}

function storePreference(key: string, value: string): void {
  try {
    localStorage.setItem(`x402-lab:${key}`, value);
  } catch {
    // Preferences are a convenience, never a requirement.
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function loadConfig(): Promise<LabConfig> {
  const res = await fetch("/config");
  if (!res.ok) throw new Error(`the local server answered /config with ${res.status}`);
  return (await res.json()) as LabConfig;
}

async function boot(): Promise<void> {
  // Exposed on purpose: when a payment goes somewhere unexpected, the first thing anyone wants is
  // the state that produced it, from the console, with no debugger attached.
  window.x402lab = app;

  app.mode = storedPreference("mode") === "advanced" ? "advanced" : "guided";
  applyTheme(storedPreference("theme"));

  app.config = await loadConfig();

  // The rail is plain links to #route, so routing is the hash and nothing else.
  window.addEventListener("hashchange", route);

  const drawer = byId<HTMLDialogElement>("sourceDrawer");
  byId("sourceButton").addEventListener("click", () => {
    paintSource();
    drawer.showModal();
  });
  byId("sourceClose").addEventListener("click", () => drawer.close());

  // The badge is a button because it has something to do in two of its three states: sign in when
  // the balance has never been read, and read it again when it has. signInWithWallet reports
  // through signInState, so there is nothing left to catch.
  byId("balanceBadge").addEventListener("click", () => void signInWithWallet());
  byId("networkButton").addEventListener("click", () => onPickNetwork?.());

  const walletButton = byId("walletButton");
  walletButton.addEventListener("click", () => {
    connectWallet().catch((error: unknown) => {
      walletButton.textContent = errorMessage(error).slice(0, 36);
    });
  });

  byId("themeButton").addEventListener("click", () => {
    const next: Theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    storePreference("theme", next);
  });

  // The first preset is the one the page opens on. Presets are ordered so that a simulation target
  // comes first where one is configured: the lab should open in a state that is safe to click.
  const [first] = app.config.presets;
  if (first) setTarget(first);
  // The first paint has nothing to transition from.
  app.route = null;
  route();
}

boot().catch((error: unknown) => {
  mount(
    byId("view"),
    el(
      "div",
      { class: "page" },
      el(
        "div",
        { class: "callout bad" },
        el("div", { class: "callout-body" }, `The lab could not start: ${errorMessage(error)}`),
      ),
    ),
  );
});

/** Persists the preferred mode, for the switch on the playground. */
export function setMode(mode: Mode): void {
  app.mode = mode;
  storePreference("mode", mode);
  render();
}
