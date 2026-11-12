// Where the run is, and what it is about to send.
//
// One object per run, reached through state(), and the two questions every step asks of it: which
// step am I, and what is in the request body. Nothing here draws anything.

import { currentTarget, defineViewState, render } from "../../app.ts";
import type { TransferWithAuthorizationTypedData } from "../../lib/abi.ts";
import type { Order } from "../../lib/agent.ts";
import { bazaarBodySchema, type JsonSchema } from "../../lib/bazaar.ts";
import {
  type CatalogOption,
  catalogOf,
  type ExpressPick,
  type FacetValue,
  PAGE_SIZE,
  type Service,
} from "../../lib/catalog.ts";
import type { TokenReadings } from "../../lib/checks.ts";
import type { JsonRecord } from "../../lib/json.ts";
import type { McpClient, McpTool } from "../../lib/mcp.ts";
import { buildForm, type Form, isRenderable, rawForm } from "../../lib/schemaform.ts";
import type { HttpResponse } from "../../lib/types.ts";
import { withViewTransition } from "../../lib/ui.ts";
import type { Simulation } from "../../lib/wallet.ts";
import type { PaymentPayload, PaymentRequired, PaymentRequirement, Quote } from "../../lib/x402.ts";

export type Transport = "http" | "mcp";
export type StepId = "choose" | "request" | "review" | "result";

export interface StepEntry {
  id: StepId;
  label: string;
}

/** What a request was sent as: the payment, its replay, a free tool call, or an order paid from the balance. */
export type Outcome = "pay" | "replay" | "call" | "balance";

/** What came back, over the transport it came back on. */
export type PlaygroundResult = { res: HttpResponse; what: Outcome } | { mcp: JsonRecord; what: Outcome };

/** The service a choice names. A recent choice remembers only these two fields. */
export type ChosenService = Pick<Service, "id" | "title">;

export interface Choice {
  service: ChosenService | null;
  option: CatalogOption | null;
  /** The service's options, or null while they are being read. */
  options: CatalogOption[] | null;
  express: ExpressPick[];
  showAllOptions: boolean;
  optionQuery: string;
  optionCaret: number | null;
  optionFocused: boolean;
}

export interface CatalogState {
  query: string;
  filters: Record<string, string>;
  page: number;
  /** The current page of services, or null before the first read. */
  services: Service[] | null;
  total: number | null;
  pageSize: number;
  inline: FacetValue[];
  /** Facet values by facet and the value of the facet it depends on. */
  values: Record<string, FacetValue[]>;
  pending: Set<string>;
  expanded: Record<string, boolean>;
  error: string | null;
  loading: boolean;
  /** Bumped per read, so only the newest of overlapping reads may write. */
  seq: number;
  searchFocused: boolean;
  caret: number | null;
}

/** The Solana transfer as signed, kept for the inspector. */
export interface SolanaTransfer {
  from: string;
  to: string;
  owner: string;
  feePayer: string;
  recentBlockhash: string;
  form: "TransferChecked" | "Transfer";
  memo: string;
  accounts: string[];
}

/** The order as the endpoint reports it now, read after the placing response. */
export interface LiveOrder {
  id: string;
  order: Order | null;
  error: string | null;
  busy: boolean;
  at: string | null;
}

export interface PlaygroundState {
  transport: Transport;
  step: StepId | null;
  /** The request body, as last read from the form. */
  body: JsonRecord | null;
  choice: Choice;
  cat: CatalogState;
  error: string | null;
  /** What the busy button says, or null when nothing is in flight. */
  busy: string | null;

  // The request form
  raw: boolean;
  form: Form | null;
  formSignature: string | null;

  // The quote and what it is checked against
  quote: Quote | null;
  raw402: HttpResponse | null;
  requirement: PaymentRequirement | null;
  railIndex: number;
  checksOpen: boolean;
  token: TokenReadings;
  /** The paying wallet's balance of the quoted asset, in atomic units. */
  balance: string | null;
  nonceUsed: boolean | null;

  // The payment
  typed: TransferWithAuthorizationTypedData | null;
  signature: string | null;
  simulation: Simulation | null;
  solanaTransfer: SolanaTransfer | null;
  payload: PaymentPayload | null;
  balanceError: string | null;
  idempotencyKey: string | null;
  idempotencyKeyFor: string | null;

  // The outcome
  result: PlaygroundResult | null;
  resultTab: "summary" | "raw";
  firstOrderId: string | null;
  live: LiveOrder | null;
  optionsError: string | null;

  // MCP
  client: McpClient | null;
  serverInfo: JsonRecord | null;
  mcpError: string | null;
  tools: McpTool[];
  tool: McpTool | null;
  toolForm: Form | null;
  toolResult: JsonRecord | null;
  /** The payment requirements a tool result carried. */
  mcpDoc: PaymentRequired | null;
}

export function emptyChoice(): Choice {
  return {
    service: null,
    option: null,
    options: null,
    express: [],
    showAllOptions: false,
    optionQuery: "",
    optionCaret: null,
    optionFocused: false,
  };
}

function emptyCatalog(): CatalogState {
  return {
    query: "",
    filters: {},
    page: 1,
    services: null,
    total: null,
    pageSize: PAGE_SIZE,
    inline: [],
    values: {},
    pending: new Set(),
    expanded: {},
    error: null,
    loading: false,
    seq: 0,
    searchFocused: false,
    caret: null,
  };
}

// The name is the one the end-to-end tests read through window.x402lab.state.pg.
export const state = defineViewState<PlaygroundState>("pg", () => ({
  transport: "http",
  step: null,
  body: null,
  choice: emptyChoice(),
  cat: emptyCatalog(),
  error: null,
  busy: null,
  raw: false,
  form: null,
  formSignature: null,
  quote: null,
  raw402: null,
  requirement: null,
  railIndex: 0,
  checksOpen: false,
  token: {},
  balance: null,
  nonceUsed: null,
  typed: null,
  signature: null,
  simulation: null,
  solanaTransfer: null,
  payload: null,
  balanceError: null,
  idempotencyKey: null,
  idempotencyKeyFor: null,
  result: null,
  resultTab: "summary",
  firstOrderId: null,
  live: null,
  optionsError: null,
  client: null,
  serverInfo: null,
  mcpError: null,
  tools: [],
  tool: null,
  toolForm: null,
  toolResult: null,
  mcpDoc: null,
}));

/** Forgets everything a quote produced, so nothing signed for one quote is shown beside another. */
export function clearPayment(s: PlaygroundState): void {
  s.quote = null;
  s.requirement = null;
  s.typed = null;
  s.signature = null;
  s.payload = null;
  s.result = null;
  s.simulation = null;
  s.solanaTransfer = null;
}

// ---------------------------------------------------------------------------
// Which steps exist, and where we are in them

export function steps(): StepEntry[] {
  const s = state();
  if (s.transport === "mcp") {
    return [
      { id: "choose", label: "Choose tool" },
      { id: "request", label: "Arguments" },
      { id: "review", label: "Review payment" },
      { id: "result", label: "Result" },
    ];
  }
  const list: StepEntry[] = [];
  if (catalogOf(currentTarget())) list.push({ id: "choose", label: "Choose" });
  list.push(
    { id: "request", label: "Request" },
    { id: "review", label: "Review payment" },
    { id: "result", label: "Result" },
  );
  return list;
}

export function currentStep(): StepId {
  const s = state();
  const ids = steps().map((step) => step.id);
  if (s.step && ids.includes(s.step)) return s.step;
  return ids[0] ?? "request";
}

export function goTo(step: StepId): void {
  if (state().step === step) return;
  // A step change is the other thing a person reads as "the screen changed", so it moves like one.
  withViewTransition(() => {
    state().step = step;
    render();
  });
}

// ---------------------------------------------------------------------------
// The request body

export function bodySchema(): JsonSchema | null {
  return bazaarBodySchema(state().quote?.doc?.extensions?.bazaar);
}

export function currentBody(): JsonRecord {
  const s = state();
  s.body ??= { ...currentTarget().sampleBody };
  return s.body;
}

export function formFor(): Form {
  const s = state();
  const schema = bodySchema();
  const renderable = isRenderable(schema) ? schema : null;
  const fields = renderable ? JSON.stringify(Object.keys(renderable.properties ?? {})) : "none";
  const signature = `${s.raw ? "raw" : "form"}:${fields}`;
  if (s.form && s.formSignature === signature) return s.form;
  s.formSignature = signature;
  s.form =
    !s.raw && renderable
      ? buildForm(renderable, { values: currentBody(), hidden: ["payment"] })
      : rawForm(currentBody());
  return s.form;
}

export function readBody(): JsonRecord {
  const body = formFor().read();
  state().body = body;
  return body;
}
