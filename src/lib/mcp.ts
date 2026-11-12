// A minimal Streamable HTTP MCP client.
//
// Minimal on purpose: this tool inspects servers, so it must not paper over what one answers. A
// client library that retries, reconnects and normalises is the wrong instrument for finding out
// that a server replies with the wrong content type or drops the session header.
//
// Transport is injected rather than calling fetch directly, because in the page every request goes
// through the local proxy (a browser cannot read a cross-origin MCP response) while the headless
// run calls the server directly. One implementation, two callers, no second copy to drift.

import type { JsonSchema } from "./bazaar.ts";
import { asRecord, isRecord } from "./json.ts";
import type { Http, HttpResponse } from "./types.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [hint: string]: unknown };
}

export interface RpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: RpcError;
}

export class McpError extends Error {
  readonly rpc: RpcError | undefined;
  constructor(message: string, rpc?: RpcError) {
    super(message);
    this.name = "McpError";
    this.rpc = rpc;
  }
}

export interface McpState {
  sessionId: string | null;
  protocolVersion: string | null;
  serverInfo: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
}

export interface RpcAnswer {
  status: number;
  message: RpcMessage | null;
  raw?: HttpResponse;
}

export interface McpClient {
  readonly state: McpState;
  initialize(options?: { clientName?: string; clientVersion?: string; protocolVersion?: string }): Promise<unknown>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  rpc(method: string, params: unknown, options?: { notification?: boolean }): Promise<RpcAnswer>;
}

let nextId = 1;

export function createMcpClient({
  http,
  endpoint,
  headers = {},
}: {
  http: Http;
  endpoint: string;
  headers?: Record<string, string>;
}): McpClient {
  const state: McpState = { sessionId: null, protocolVersion: null, serverInfo: null, capabilities: null };

  async function rpc(method: string, params: unknown, { notification = false } = {}): Promise<RpcAnswer> {
    const body = notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: nextId++, method, params };

    const sent: Record<string, string> = {
      ...headers,
      // Both types are required: a Streamable HTTP server may answer with a JSON body or with an
      // SSE stream, and it chooses. A client that accepts only one gets a 406 from a correct
      // server and blames the server.
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (state.sessionId) sent["mcp-session-id"] = state.sessionId;
    if (state.protocolVersion) sent["mcp-protocol-version"] = state.protocolVersion;

    const res = await http({ method: "POST", url: endpoint, headers: sent, body });
    if (res.transportError) throw new Error(res.transportError);

    const session = res.headers["mcp-session-id"];
    if (session) state.sessionId = session;

    // A notification is answered with 202 and no body, which is correct and not an error.
    if (notification) return { status: res.status, message: null };
    return { status: res.status, message: parseRpcBody(res), raw: res };
  }

  async function call(method: string, params: unknown): Promise<unknown> {
    const { status, message } = await rpc(method, params);
    if (!message) throw new Error(`${method}: ${status} with no JSON-RPC message in the body`);
    if (message.error) throw new McpError(message.error.message || `${method} failed`, message.error);
    return message.result;
  }

  return {
    state,
    async initialize({
      clientName = "x402-lab",
      clientVersion = "0.1.0",
      protocolVersion = MCP_PROTOCOL_VERSION,
    } = {}) {
      const result = asRecord(
        await call("initialize", {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: clientName, version: clientVersion },
        }),
      );
      state.protocolVersion = typeof result.protocolVersion === "string" ? result.protocolVersion : protocolVersion;
      state.serverInfo = isRecord(result.serverInfo) ? result.serverInfo : null;
      state.capabilities = isRecord(result.capabilities) ? result.capabilities : null;
      // The spec has the client confirm before calling anything. A stateless server ignores it;
      // a stateful one is waiting for it.
      await rpc("notifications/initialized", {}, { notification: true }).catch(() => undefined);
      return result;
    },
    async listTools() {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = asRecord(await call("tools/list", cursor ? { cursor } : {}));
        if (Array.isArray(page.tools)) {
          for (const tool of page.tools) if (isTool(tool)) tools.push(tool);
        }
        cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
      } while (cursor);
      return tools;
    },
    async callTool(name, args) {
      return call("tools/call", { name, arguments: args ?? {} });
    },
    rpc,
  };
}

function isTool(value: unknown): value is McpTool {
  return isRecord(value) && typeof value.name === "string";
}

function asMessage(value: unknown): RpcMessage | null {
  return isRecord(value) ? (value as RpcMessage) : null;
}

/**
 * Reads a JSON-RPC message out of either shape a Streamable HTTP server may answer with. The SSE
 * case is parsed rather than streamed: these are single request/response calls, and a stream that
 * has already arrived in full is just text with prefixes.
 */
export function parseRpcBody(res: Pick<HttpResponse, "headers" | "body">): RpcMessage | null {
  const type = res.headers["content-type"] ?? "";
  const text = res.body;
  if (type.includes("text/event-stream") || /^event:|^data:/m.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const message = asMessage(JSON.parse(payload));
        // Skip server-initiated notifications; the answer is the one carrying a result or error.
        if (message && (message.result !== undefined || message.error !== undefined)) return message;
      } catch {
        // Keep reading: a malformed frame is reported by the caller as a missing message.
      }
    }
    return null;
  }
  try {
    return asMessage(JSON.parse(text));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reading a tool list
// ---------------------------------------------------------------------------

/**
 * Guesses whether a tool moves money, so the lint can insist it says so itself. The guess is
 * deliberately generous: a read-only tool wrongly caught here still passes as soon as it declares
 * readOnlyHint, and a spend tool that declares nothing is exactly what the check is for.
 */
export function looksLikeSpending(tool: McpTool): boolean {
  const hints = tool.annotations ?? {};
  if (hints.readOnlyHint === true) return false;
  if (hints.destructiveHint === true) return true;
  return /\b(pay|paid|order|buy|purchase|charge|refund|withdraw|transfer|send|spend)\b/i.test(
    `${tool.name} ${tool.description ?? ""}`,
  );
}

export interface DanglingReference {
  tool: string;
  names: string;
}

/**
 * Finds a description that routes an agent to a tool this server does not register. Matching is
 * whole-identifier: `place_order` sits inside `create_paid_order`, and a substring check reports a
 * dangling reference against correct copy. A false alarm is what gets a check switched off.
 */
export function danglingToolReferences(tools: readonly McpTool[]): DanglingReference[] {
  const registered = new Set(tools.map((t) => t.name));
  const findings: DanglingReference[] = [];
  const identifier = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
  for (const tool of tools) {
    const texts = [tool.description ?? ""];
    for (const prop of Object.values(tool.inputSchema?.properties ?? {})) texts.push(prop.description ?? "");
    for (const text of texts) {
      for (const match of text.match(identifier) ?? []) {
        if (registered.has(match)) continue;
        // Only flag identifiers that read like a tool name being offered as a next step, not any
        // snake_case argument name a description mentions.
        if (!/\b(call|use|then|via)\b[^.]{0,40}$/i.test(text.slice(0, text.indexOf(match)))) continue;
        findings.push({ tool: tool.name, names: match });
      }
    }
  }
  return findings;
}
