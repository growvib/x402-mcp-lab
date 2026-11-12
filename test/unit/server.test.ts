// The proxy's four fences, tested by trying to get past each one.
//
// This half of the tool forwards requests on a developer's machine, and the page it serves can
// move money. Any one fence alone would be thin, so each is asserted separately: a change that
// removes one should fail here rather than in somebody's browser.

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:http";
import type { Server } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createFixture } from "../../fixtures/mock-x402.ts";
import { asRecord, isRecord } from "../../src/lib/json.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const PORT = 4471;
const FIXTURE_PORT = 4972;

let lab: ChildProcess | undefined;
let fixture: Server | undefined;
let token = "";

interface Answer {
  status: number;
  body: string;
}

function call({
  method = "GET",
  path = "/",
  headers = {},
  body,
}: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  // The server serves the built page from dist/, and answers a static path with 503 until there is
  // one. The traversal case below is a static path, so build first: a 503 would pass for the wrong
  // reason.
  if (!existsSync(join(ROOT, "dist", "index.html"))) {
    const built = spawnSync(process.execPath, ["scripts/build.ts"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(built.status, 0, `the page did not build: ${built.stderr}`);
  }

  const server = createFixture();
  fixture = server;
  await new Promise<void>((resolve) => server.listen(FIXTURE_PORT, "127.0.0.1", resolve));

  const child = spawn(process.execPath, ["server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      // "localhost" resolves to ::1 first on some machines (GitHub's runners among them) and to
      // 127.0.0.1 on others. The requests below go to 127.0.0.1, so bind there explicitly rather
      // than inherit whatever this machine's resolver prefers.
      X402_LAB_HOST: "127.0.0.1",
      X402_LAB_PRESETS: "fixture",
      X402_LAB_ALLOW: `http://127.0.0.1:${FIXTURE_PORT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  lab = child;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the lab did not start")), 8000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (String(chunk).includes("x402 lab on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the lab exited with ${code} before it started`));
    });
  });
  const config: unknown = JSON.parse((await call({ path: "/config" })).body);
  token = String(asRecord(config).token ?? "");
});

after(() => {
  lab?.kill();
  fixture?.close();
});

test("the session token is minted per run and served only to the page", () => {
  assert.match(token, /^[0-9a-f-]{36}$/);
});

test("a request whose Host is not loopback is refused before it is read", async () => {
  // This is the DNS-rebinding case: a page on the open internet resolving its own domain to
  // 127.0.0.1 keeps its own Host header, which is the one thing it cannot forge.
  const res = await call({ path: "/config", headers: { host: "evil.example.com" } });
  assert.equal(res.status, 403);
  assert.match(res.body, /localhost/);
});

test("forwarding without the session token is refused", async () => {
  const res = await call({
    method: "POST",
    path: "/proxy",
    headers: { "content-type": "application/json" },
    body: { method: "GET", url: `http://127.0.0.1:${FIXTURE_PORT}/resource` },
  });
  assert.equal(res.status, 403);
  assert.match(res.body, /session token/);
});

test("forwarding to an origin that is not allowed is refused, and says how to allow it", async () => {
  const res = await call({
    method: "POST",
    path: "/proxy",
    headers: { "content-type": "application/json", "x-x402-lab": token },
    body: { method: "GET", url: "https://api.example.com/v1/agent/orders" },
  });
  assert.equal(res.status, 403);
  assert.match(res.body, /X402_LAB_ALLOW=https:\/\/api.example.com/);
});

test("an allowed origin is forwarded with its status, headers and body intact", async () => {
  const res = await call({
    method: "POST",
    path: "/proxy",
    headers: { "content-type": "application/json", "x-x402-lab": token },
    body: { method: "POST", url: `http://127.0.0.1:${FIXTURE_PORT}/resource`, body: { item: "widget", quantity: 1 } },
  });
  assert.equal(res.status, 200);
  const forwarded = asRecord(JSON.parse(res.body));
  assert.equal(forwarded.status, 402);
  // The raw header is what a browser client cannot read for itself, and the whole reason the
  // proxy exists.
  assert.ok(
    isRecord(forwarded.headers) && forwarded.headers["payment-required"],
    "the PAYMENT-REQUIRED header did not come back",
  );
  assert.match(String(forwarded.body), /"accepts"/);
});

test("a path that tries to leave the page's directory is refused", async () => {
  for (const path of ["/../server.ts", "/%2e%2e/server.ts", "/..%2fserver.ts"]) {
    const res = await call({ path });
    assert.ok(res.status === 403 || res.status === 404, `serving ${path} answered ${res.status}`);
    assert.doesNotMatch(res.body, /X402_LAB_ALLOW/, `${path} leaked the server's own source`);
  }
});
