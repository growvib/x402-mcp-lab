// Redaction for anything that leaves this browser.
//
// A run log is the most useful thing to paste into an issue and the easiest way to hand somebody
// your credentials. The response to a successful payment carries an `agent_token`: a bearer token
// that spends the balance the payment just created. Exporting a run without stripping it means a
// GitHub comment that lets a stranger spend your money.
//
// So: exports are redacted by DEFAULT, the count of what was removed is shown rather than hidden,
// and the unredacted copy stays a deliberate second action.

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Bearer credentials in a header line or a curl command.
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1<redacted>"],
  [/(authorization"?\s*[:=]\s*"?)[^"'\s,}]{12,}/gi, "$1<redacted>"],
  // Any JSON field whose name says it is a credential.
  [/("(?:agent_token|access_token|api_key|apiKey|token|secret|password)"\s*:\s*")[^"]{8,}(")/gi, "$1<redacted>$2"],
  // The signed payment payload: base64 JSON carrying a signature, and the signature itself.
  [/(PAYMENT-SIGNATURE"?\s*[:=]\s*"?)[A-Za-z0-9+/=]{40,}/gi, "$1<redacted>"],
  [/("signature"\s*:\s*")0x[0-9a-f]{100,}(")/gi, "$1<redacted>$2"],
];

export interface Redacted {
  text: string;
  /** How many credentials were removed, so the person exporting knows something is missing. */
  removed: number;
}

/** The text with credentials removed, and how many removals happened. */
export function redact(input: unknown): Redacted {
  let text = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  let removed = 0;
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, (...groups: string[]) => {
      removed += 1;
      return replacement.replace(/\$(\d)/g, (_, index: string) => groups[Number(index)] ?? "");
    });
  }
  return { text, removed };
}

/** The cheap pre-check the UI uses before a copy that is deliberately NOT redacted. */
export function looksSensitive(input: unknown): boolean {
  return redact(input).removed > 0;
}

/**
 * A credential rendered for the screen: enough to tell two tokens apart, never enough to use one.
 * Shoulder surfing and screen shares are the threat here, not an attacker on the wire.
 */
export function maskToken(token: string | null | undefined): string {
  const text = token ?? "";
  if (text.length <= 12) return "•".repeat(text.length);
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}
