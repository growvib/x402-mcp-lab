// Every check, watched going red.
//
// A conformance suite that has only ever been run against a healthy server is a suite nobody
// should trust: the checks pass, and whether they CAN fail is unknown. So each case below breaks
// the fixture in exactly one way and asserts that exactly the matching check goes to the state it
// is supposed to, while a healthy fixture keeps it green.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createFixture } from "../../fixtures/mock-x402.ts";
import { type Outcome, type Report, runSuite } from "../../src/lib/conformance.ts";
import { errorMessage } from "../../src/lib/json.ts";
import type { HttpRequest, HttpResponse } from "../../src/lib/types.ts";

// The same envelope the page's proxy and the CLI produce, over a direct fetch.
async function http({ method = "GET", url = "", headers = {}, body }: HttpRequest): Promise<HttpResponse> {
  const sent: Record<string, string> = { ...headers };
  let payload: string | undefined;
  if (body !== undefined && body !== null && method !== "GET" && method !== "HEAD") {
    payload = typeof body === "string" ? body : JSON.stringify(body);
    if (!Object.keys(sent).some((k) => k.toLowerCase() === "content-type")) sent["content-type"] = "application/json";
  }
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers: sent, body: payload ?? null, redirect: "manual" });
    const text = await res.text();
    const out: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return { status: res.status, ms: Date.now() - started, headers: out, body: text };
  } catch (error) {
    return { status: 0, ms: 0, headers: {}, body: "", transportError: errorMessage(error) };
  }
}

async function reportFor(flaws: string[]): Promise<Report> {
  const server = createFixture({ flaws });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await runSuite({
      http,
      target: {
        url: `http://127.0.0.1:${port}/resource`,
        method: "POST",
        body: { item: "widget", quantity: 1 },
        mcpEndpoint: `http://127.0.0.1:${port}/mcp`,
      },
      options: {},
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const stateOf = (report: Report, id: string): Outcome | undefined => report.checks.find((c) => c.id === id)?.state;

test("a conformant resource passes every check that can run", async () => {
  const report = await reportFor([]);
  const failures = report.checks.filter((c) => c.state === "fail" || c.state === "warn");
  assert.deepEqual(
    failures.map((f) => `${f.id}: ${f.detail}`),
    [],
  );
  assert.equal(report.counts.fail, 0);
  assert.ok(report.counts.pass >= 20, `only ${report.counts.pass} checks passed`);
  // The money checks are skipped and MUST NOT be counted as passes.
  assert.equal(stateOf(report, "money-replay"), "skip");
  assert.equal(stateOf(report, "money-duplicate"), "skip");
});

// flaw -> the check that must notice it, and the state it must reach.
const CASES: ReadonlyArray<readonly [flaw: string, checkId: string, want: Outcome]> = [
  ["amount-number", "accepts-fields", "fail"],
  ["no-domain", "accepts-fields", "fail"],
  ["bad-network", "accepts-fields", "fail"],
  ["no-timeout", "accepts-fields", "fail"],
  ["v1-amount", "accepts-fields", "warn"],
  ["no-accepts", "accepts", "fail"],
  ["no-header", "header-parity", "fail"],
  ["header-drift", "header-parity", "fail"],
  ["head-405", "head-probe", "fail"],
  ["no-expose", "cors-expose", "fail"],
  ["no-cors", "cors-origin", "warn"],
  ["no-allow-payment", "cors-preflight", "fail"],
  ["bad-preflight", "cors-preflight", "fail"],
  ["no-resource", "resource-block", "warn"],
  ["resource-relative", "resource-block", "fail"],
  ["no-bazaar", "bazaar", "warn"],
  ["no-descriptions", "bazaar-descriptions", "warn"],
  ["no-well-known", "well-known", "warn"],
  ["crash-on-garbage", "malformed-payment", "fail"],
  ["accept-forged", "forged-signature", "fail"],
  ["mcp-dangling", "mcp-dangling", "fail"],
  ["mcp-unmarked", "mcp-annotations", "warn"],
  ["mcp-no-schema", "mcp-schemas", "fail"],
  ["mcp-no-arg-descriptions", "mcp-arg-descriptions", "warn"],
];

for (const [flaw, checkId, want] of CASES) {
  test(`${flaw} is caught by ${checkId}`, async () => {
    const healthy = await reportFor([]);
    assert.equal(stateOf(healthy, checkId), "pass", `${checkId} is not green on a healthy fixture`);

    const broken = await reportFor([flaw]);
    assert.equal(
      stateOf(broken, checkId),
      want,
      `${checkId} did not go ${want} with ${flaw} on: ${broken.checks.find((c) => c.id === checkId)?.detail}`,
    );
  });
}
