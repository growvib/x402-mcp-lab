// The MCP half of the flow.
//
// An MCP server carries the same handshake with the requirements in a tool result instead of a 402
// header, so everything past this file is shared: the same checks, the same signer, the same
// outcome. What is here is the client, the tool list, and the translation of a tool result into
// the payment requirement the rest of the page already understands.

import { currentTarget, http, render, url } from "../../app.ts";
import { asRecord, errorMessage, isRecord, type JsonRecord } from "../../lib/json.ts";
import { createMcpClient, looksLikeSpending, type McpTool } from "../../lib/mcp.ts";
import { buildForm, isRenderable } from "../../lib/schemaform.ts";
import { el } from "../../lib/ui.ts";
import { type PaymentRequired, type PaymentRequirement, selectRequirements } from "../../lib/x402.ts";
import { gatherFacts } from "./facts.ts";
import { goTo, type Outcome, state } from "./state.ts";

export async function connectMcp(): Promise<void> {
  const s = state();
  s.mcpError = null;
  const client = createMcpClient({
    http: (request) => {
      const method = isRecord(request.body) && typeof request.body.method === "string" ? request.body.method : "";
      return http({ ...request, note: method ? `MCP ${method}` : "MCP" });
    },
    endpoint: url(currentTarget().mcp),
  });
  s.client = client;
  try {
    s.serverInfo = asRecord(await client.initialize());
    s.tools = await client.listTools();
  } catch (error) {
    s.mcpError = errorMessage(error);
    s.serverInfo = null;
    s.tools = [];
  }
  render();
}

export function chooseTool(tool: McpTool): void {
  const s = state();
  s.tool = tool;
  s.form = null;
  s.formSignature = null;
  s.toolForm = isRenderable(tool.inputSchema)
    ? buildForm(tool.inputSchema, { hidden: ["payment"] })
    : buildForm({ type: "object", properties: {} });
  goTo("request");
}

export async function callTool(extra: JsonRecord = {}): Promise<void> {
  const s = state();
  s.error = null;
  const { client, tool } = s;
  if (!client || !tool) {
    s.error = "Connect to the server and choose a tool first.";
    render();
    return;
  }
  const args = { ...(s.toolForm?.read() ?? {}), ...extra };
  let toolResult: JsonRecord;
  try {
    toolResult = asRecord(await client.callTool(tool.name, args));
  } catch (error) {
    s.error = errorMessage(error);
    render();
    return;
  }
  s.toolResult = toolResult;

  const found = requirementFromResult(toolResult);
  if (found) {
    s.mcpDoc = found.doc;
    s.requirement = found.requirement;
    s.quote = null;
    await gatherFacts();
    goTo("review");
    return;
  }
  s.result = { mcp: toolResult, what: extra.payment ? "pay" : "call" };
  goTo("result");
}

export async function sendMcp(what: Outcome): Promise<void> {
  const s = state();
  await callTool({ payment: s.payload });
  if (s.toolResult) s.result = { mcp: s.toolResult, what };
  goTo("result");
}

/** A content block of a tool result, as far as this page reads one. */
function contentBlocks(result: JsonRecord): JsonRecord[] {
  return Array.isArray(result.content) ? result.content.filter(isRecord) : [];
}

/**
 * Finds payment requirements wherever a server put them. MCP gives no place the spec insists on,
 * so the obvious three are all read rather than one being demanded.
 */
function requirementFromResult(result: JsonRecord): { requirement: PaymentRequirement; doc: PaymentRequired } | null {
  const structured = result.structuredContent ?? contentBlocks(result).find((block) => block.type === "json")?.json;
  const nested = isRecord(structured) ? structured.payment : undefined;
  for (const candidate of [structured, nested, parseText(result)]) {
    if (!isRecord(candidate)) continue;
    // A document read off a server under test: every field is optional and checked where it is used.
    const doc = candidate as PaymentRequired;
    const entries = selectRequirements(doc);
    const chosen = entries.find((entry) => entry.rail === "evm") ?? entries[0];
    if (chosen) return { requirement: chosen.req, doc };
  }
  return null;
}

function parseText(result: JsonRecord): unknown {
  const text = contentBlocks(result).find((block) => block.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Render

export function chooseToolCard(): HTMLElement {
  const s = state();
  if (!currentTarget().mcp) {
    return el(
      "div",
      { class: "callout info" },
      el(
        "div",
        { class: "callout-body" },
        el("b", {}, "This source has no MCP endpoint. "),
        "Open Source in the top bar and add one: any Streamable HTTP MCP server works.",
      ),
    );
  }
  const serverName = isRecord(s.serverInfo?.serverInfo) ? s.serverInfo.serverInfo.name : undefined;
  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card-head" },
      el("h3", {}, "Tools on this server"),
      el("div", { class: "grow" }),
      s.serverInfo
        ? el(
            "span",
            { class: "pill" },
            `${typeof serverName === "string" ? serverName : "server"} · ${s.tools.length} tools`,
          )
        : el("button", { class: "sm primary", onClick: () => void connectMcp() }, "Connect"),
    ),
    el(
      "div",
      { class: "card-body" },
      s.mcpError ? el("div", { class: "callout bad" }, el("div", { class: "callout-body" }, s.mcpError)) : null,
      !s.serverInfo && !s.mcpError
        ? el("p", { class: "help" }, "Connect to read the tools this server registers, with what each one costs you.")
        : null,
      s.tools.length
        ? el(
            "div",
            { class: "option-list" },
            ...s.tools.map((tool) =>
              el(
                "button",
                { class: `option ${s.tool?.name === tool.name ? "on" : ""}`, onClick: () => chooseTool(tool) },
                el(
                  "div",
                  { class: "option-main" },
                  el("div", { class: "option-title mono" }, tool.name),
                  el("div", { class: "option-sub" }, (tool.description ?? "").slice(0, 120)),
                ),
                looksLikeSpending(tool)
                  ? el("span", { class: "pill warn" }, "costs money")
                  : el("span", { class: "pill" }, "free"),
              ),
            ),
          )
        : null,
    ),
  );
}
