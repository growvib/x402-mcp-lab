#!/usr/bin/env node
//
// The local host and proxy for x402 Lab.
//
// Two jobs, and deliberately no third:
//
//  1. Serve the page. The page drives a BROWSER wallet, so the private key never reaches this
//     process, a file, or the network. Signing an EIP-3009 authorization is an EIP-712 typed-data
//     signature, which every browser wallet can produce, so the whole x402 handshake works with
//     nothing to leak.
//  2. Forward requests the browser cannot make itself. A paid resource rarely allows a localhost
//     origin, and reading the PAYMENT-REQUIRED header needs it exposed; proxying sidesteps both
//     and hands the page the raw status, headers and body in one envelope.
//
// It is a developer tool that can move money, so the forwarding half is fenced in four ways:
// it binds to loopback, it refuses a request whose Host header is not loopback (which is what
// stops a DNS-rebinding page on the open internet from driving it), it requires a session token
// minted at startup and readable only same-origin, and it forwards only to origins on an
// allowlist. Any one of those alone would be thin; together a stranger's browser tab cannot reach
// it even while this is running.
//
// No runtime dependencies, on purpose: a tool for deciding whether money moved correctly should
// not itself pull in a dependency tree. The page it serves is the esbuild bundle in dist/.

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { asRecord, errorMessage, isRecord } from "./src/lib/json.ts";
import type { HttpResponse, LabConfig, Preset } from "./src/lib/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const PORT = Number(process.env.PORT || 4402);
// X402_LAB_HOST names the interface to bind, for a setup where "localhost" resolves somewhere
// inconvenient. It must still be loopback, and that is CHECKED before binding (see loopbackBind):
// the Host-header guard further down is the DNS-rebinding fence and stops a browser, not a client
// that sets its own headers, so the bind address is the thing keeping this off the network.
const HOST = String(process.env.X402_LAB_HOST || "localhost");
const SESSION_TOKEN = randomUUID();
const MAX_BODY_BYTES = 2_000_000;
const UPSTREAM_TIMEOUT_MS = 60_000;

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// A hop-by-hop header set by a caller is either meaningless or a way to confuse the upstream.
const DROPPED_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding"]);

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// The origins this proxy may forward to. Presets add their own; X402_LAB_ALLOW adds more, comma
// separated. Everything else is refused with a message that says how to allow it, because a
// silent refusal on a payment tool reads as an outage.
function allowedOrigins(presets: readonly Preset[]): Set<string> {
  const fromEnv = String(process.env.X402_LAB_ALLOW || "")
    .split(",")
    .map((entry) => originOf(entry.trim()));
  const fromPresets = presets.flatMap((preset) => [originOf(preset.origin), originOf(preset.facilitator)]);
  const legacy = originOf(process.env.GROWVIB_API);
  const all = [...fromEnv, ...fromPresets, legacy, "http://localhost:8080", "http://127.0.0.1:8080"];
  return new Set(all.filter((origin): origin is string => Boolean(origin)));
}

// The default list opens on the bundled demo server. A tool that can move money should open in a
// state where clicking everything is free, and reaching production should be a deliberate step.
async function loadPresets(): Promise<Preset[]> {
  const names = String(process.env.X402_LAB_PRESETS || "fixture,growvib")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const presets: Preset[] = [];
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(HERE, "presets", `${name}.json`), "utf8"));
      if (!isRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.origin !== "string") {
        throw new Error("it is not an object with an id and an origin");
      }
      presets.push(parsed as unknown as Preset);
    } catch (error) {
      console.error(`preset ${name} could not be read: ${errorMessage(error)}`);
    }
  }
  return presets;
}

async function packageVersion(): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(HERE, "package.json"), "utf8"));
    const { version } = asRecord(parsed);
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
    // No caching: every answer here is about the state of a live payment.
    "cache-control": "no-store",
  });
  res.end(raw);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// loopbackHost is the DNS-rebinding guard. A page on the open internet can be made to resolve its
// own domain to 127.0.0.1, which defeats the browser's origin rules, but it cannot change the Host
// header it sends. Anything that is not literally loopback is refused before it is read.
function loopbackHost(req: IncomingMessage): boolean {
  const host = String(req.headers.host || "");
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

interface ForwardRequest {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  body: unknown;
}

// forward performs the upstream call and hands back everything the page needs to judge it: the
// status, every response header, and the body as TEXT. Text rather than parsed JSON because an
// error page or an empty body is itself diagnostic, and swallowing it as a parse failure would
// hide the one thing you came here to see.
async function forward({ method, url, headers, body }: ForwardRequest): Promise<HttpResponse> {
  const sent: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null || value === "") continue;
    if (DROPPED_HEADERS.has(key.toLowerCase())) continue;
    sent[key] = String(value);
  }
  let payload: string | undefined;
  if (body !== undefined && body !== null && method !== "GET" && method !== "HEAD") {
    payload = typeof body === "string" ? body : JSON.stringify(body);
    if (!Object.keys(sent).some((key) => key.toLowerCase() === "content-type")) {
      sent["content-type"] = "application/json";
    }
  }

  const started = Date.now();
  const upstream = await fetch(url, {
    method,
    headers: sent,
    ...(payload === undefined ? {} : { body: payload }),
    redirect: "manual",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const text = await upstream.text();
  const out: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return { status: upstream.status, ms: Date.now() - started, headers: out, body: text };
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  // Resolve plus a containment check: the page is a static bundle and there is no reason for a path
  // to leave it, so one that tries is a bug or a probe.
  const file = resolve(DIST, `.${pathname === "/" ? "/index.html" : pathname}`);
  const inside = relative(DIST, file);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    json(res, 403, { error: "outside the app directory" });
    return;
  }
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    // The bundle is a build output, so its absence on a fresh clone is the common case and gets a
    // message that says what to do rather than a bare 404.
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("The page has not been built yet. Run `npm run build` (or `npm start`), then reload.\n");
      return;
    }
    json(res, 404, { error: "not found" });
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function handleProxy(req: IncomingMessage, res: ServerResponse, allowed: ReadonlySet<string>): Promise<void> {
  if (req.headers["x-x402-lab"] !== SESSION_TOKEN) {
    json(res, 403, { error: "missing or stale session token: reload the page" });
    return;
  }
  const payload = asRecord(JSON.parse(await readBody(req)));
  const method = String(payload.method || "GET").toUpperCase();
  const target = String(payload.url || "");
  const origin = originOf(target);
  if (!origin) {
    json(res, 400, { error: `not an absolute url: ${target}` });
    return;
  }
  if (!allowed.has(origin)) {
    json(res, 403, {
      error: `${origin} is not on this proxy's allowlist. Restart with X402_LAB_ALLOW=${origin} to let this tool talk to it.`,
    });
    return;
  }
  try {
    // The page's own origin travels with the request. Without it the upstream sees a call from
    // nowhere, which matters for one thing in particular: an ERC-4361 sign-in message names the
    // authority that asked for it, and an endpoint that cannot see who asked has to name itself,
    // which is what makes a wallet show "Domain Mismatch" on an honest sign-in. This proxy stands
    // where the browser would have stood, so it says what the browser would have said. Taken from
    // the incoming request's own Origin header (the browser sets it on this POST and a page cannot
    // forge it), never from the payload.
    const from = req.headers.origin;
    const headers: Record<string, unknown> = { ...asRecord(payload.headers) };
    if (from && !Object.keys(headers).some((key) => key.toLowerCase() === "origin")) {
      headers.origin = from;
    }
    json(res, 200, await forward({ method, url: target, headers, body: payload.body }));
  } catch (error) {
    // An upstream failure is REPORTED, never rendered as an empty success: on a paying request the
    // difference between "refused" and "we could not tell" is the difference between safe to retry
    // and absolutely not.
    json(res, 200, { status: 0, transportError: errorMessage(error) });
  }
}

// Loopback only. This page can move real money, so it is not something to expose on a LAN.
//
// Bound by NAME rather than to 127.0.0.1, and the name is what gets printed, because a wallet
// extension treats the two differently: several refuse to inject into a bare IP origin, and one
// that does inject makes "localhost" and "127.0.0.1" separate origins with separate permissions,
// so a wallet approved on one is a wallet missing on the other. `localhost` is also what the
// endpoint's sign-in message will name, and a matching name is the whole point of that.
//
// The name is RESOLVED and refused unless it is loopback, before anything is bound. The Host
// header check inside the server is the DNS-rebinding fence and it only stops a browser: a client
// that writes its own headers walks past it. So this is the check that decides whether anyone off
// this machine can reach a page that holds a session token and proxies to an allowlist including
// whatever is on localhost:8080.
async function loopbackBind(host: string): Promise<void> {
  let address: string;
  try {
    ({ address } = await lookup(host));
  } catch (error) {
    console.error(`X402_LAB_HOST=${host} does not resolve (${errorMessage(error)}). Refusing to bind.`);
    process.exit(1);
  }
  // 127.0.0.0/8 and ::1. Not 0.0.0.0, not "::", not a LAN address: this page can move real money
  // and holds the token that drives the proxy.
  const loopback = address === "::1" || address.startsWith("127.");
  if (!loopback) {
    console.error(`X402_LAB_HOST=${host} resolves to ${address}, which is not loopback. Refusing to bind.`);
    console.error("This page holds a session token and proxies to its allowlist, so it stays on this machine.");
    process.exit(1);
  }
}

const presets = await loadPresets();
const allowed = allowedOrigins(presets);
const config: LabConfig = {
  token: SESSION_TOKEN,
  presets,
  allowedOrigins: [...allowed],
  version: await packageVersion(),
};

const server = createServer(async (req, res) => {
  try {
    if (!loopbackHost(req)) {
      json(res, 403, { error: "x402 lab only answers on localhost" });
      return;
    }
    // A base for parsing only: the path and the query are what this reads, never the host.
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

    if (req.method === "GET" && url.pathname === "/config") {
      json(res, 200, config);
      return;
    }
    if (req.method === "POST" && url.pathname === "/proxy") {
      await handleProxy(req, res, allowed);
      return;
    }
    if (req.method === "GET") {
      // The browser asks for a favicon on every load. Answering 204 keeps a meaningless 404 out of
      // the console, which in this page is where real failures are meant to stand out.
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      await serveStatic(res, url.pathname);
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: errorMessage(error) });
  }
});

await loopbackBind(HOST);

server.listen(PORT, HOST, () => {
  console.log(`x402 lab on http://${HOST}:${PORT}`);
  console.log(`forwarding to: ${[...allowed].join(", ") || "(nothing yet: add one with X402_LAB_ALLOW)"}`);
});
