// The rails around paying.
//
// The pre-flight table answers "is this quote sound". This file answers a different question:
// "should this tool let a payment happen AT ALL right now". They fail in different ways. A sound
// quote paid forty times in a loop by a stuck retry is still forty payments, and the check table
// would pass every one of them.
//
// Every rail here exists because a browser tool driving a wallet can be made to repeat itself: a
// double click, a re-render that re-fires a handler, a page left open on a target that later
// becomes production. None of these need an attacker.

import type { Target } from "./types.ts";

export interface GateLimits {
  /** A person cannot deliberately pay twice in four seconds, so anything faster is a bug or a loop. */
  cooldownMs: number;
  /** A session that has paid ten times is a test run that should be using simulation, or unwatched. */
  maxPaymentsPerSession: number;
}

const DEFAULTS: GateLimits = { cooldownMs: 4000, maxPaymentsPerSession: 10 };

export interface PaymentGate {
  readonly state: { inFlight: boolean; lastPaymentAt: number; payments: number };
  readonly limits: GateLimits;
  /**
   * Why a payment must not start, or null when it may. The caller treats a reason as final for this
   * click: no queueing, no retry timer, no "try again in a moment".
   */
  check(): string | null;
  begin(): void;
  /**
   * Called on EVERY outcome, including a refusal and a thrown error. A gate that only opens on
   * success is a gate that locks the tool after the first failure.
   */
  end(outcome?: { paid?: boolean }): void;
  remaining(): number;
}

export function createPaymentGate(options: Partial<GateLimits> = {}): PaymentGate {
  const limits: GateLimits = { ...DEFAULTS, ...options };
  const state = { inFlight: false, lastPaymentAt: 0, payments: 0 };

  return {
    state,
    limits,
    check() {
      if (state.inFlight) {
        return "a payment from this tab is already in flight. Wait for it to resolve: sending a second one is how the same order gets paid for twice.";
      }
      const since = Date.now() - state.lastPaymentAt;
      if (state.lastPaymentAt && since < limits.cooldownMs) {
        return `another payment went out ${Math.round(since / 1000)}s ago. The lab waits ${limits.cooldownMs / 1000}s between payments, because nothing legitimate pays faster than that.`;
      }
      if (state.payments >= limits.maxPaymentsPerSession) {
        return `this tab has already made ${state.payments} payments. Reload to start a new session, or switch to the simulation target if you are testing.`;
      }
      return null;
    },
    begin() {
      state.inFlight = true;
    },
    end({ paid = false } = {}) {
      state.inFlight = false;
      if (paid) {
        state.payments += 1;
        state.lastPaymentAt = Date.now();
      }
    },
    remaining() {
      return Math.max(0, limits.maxPaymentsPerSession - state.payments);
    },
  };
}

export function isMainnet(target: Target | null | undefined): boolean {
  return target?.environment === "mainnet";
}

/**
 * True for a target that cannot move money: the bundled fixture, or anything on loopback. Read
 * from the TARGET rather than from a toggle, because a mode switch that does not change where the
 * requests go is theatre.
 */
export function isSimulation(target: Target | null | undefined): boolean {
  if (!target) return false;
  if (target.environment === "fixture" || target.environment === "simulation") return true;
  try {
    const host = new URL(target.origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

export interface EnvironmentLabel {
  text: string;
  kind: "accent" | "warn";
  detail: string;
}

/**
 * What the environment badge says. Plain words first: somebody who has never read the x402 spec
 * still has to understand whether this costs money.
 *
 * Mainnet is stated, not alarmed about. Red in this page means something went wrong, and a
 * permanent red badge in the top bar of a tool whose whole subject is real payments is an alarm
 * nobody hears. The warnings that matter are attached to an action (a failing check, a recipient
 * that is not the one you pinned), and those stay loud.
 */
export function environmentLabel(target: Target | null | undefined): EnvironmentLabel {
  if (isSimulation(target)) return { text: "Simulation", kind: "accent", detail: "No wallet, no real payments" };
  if (isMainnet(target)) return { text: "Mainnet", kind: "warn", detail: "Payments here are real and final" };
  return {
    text: target?.environment === "testnet" ? "Testnet" : "Live endpoint",
    kind: "warn",
    detail: "Payments here leave your wallet",
  };
}
