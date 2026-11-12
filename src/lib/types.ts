// The shapes shared across the page, the CLI and the tests.
//
// Two families: the transport envelope every request travels in, and the source configuration a
// preset declares. The x402 documents themselves live in x402.ts beside the code that reads them.

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface HttpRequest {
  method?: string;
  /** An absolute URL. Takes precedence over `path`. */
  url?: string;
  /** A path resolved against the current source's origin. */
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** What the request is for, shown in the run log. */
  note?: string;
}

/**
 * The envelope every answer arrives in, whether it came through the page's proxy or from a direct
 * fetch in the CLI, so the code that judges a response cannot tell which transport it ran under.
 */
export interface HttpResponse {
  /** The upstream status, or 0 when there was no answer. */
  status: number;
  ms?: number;
  /** Response headers, lowercased. */
  headers: Record<string, string>;
  /** The body as text: an error page or an empty body is itself diagnostic. */
  body: string;
  /** Set when the request never got an answer: a refused origin, a timeout, a reset. */
  transportError?: string;
}

export type Http = (request: HttpRequest) => Promise<HttpResponse>;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type Environment = "mainnet" | "testnet" | "fixture" | "simulation" | "unknown";

export interface FacetConfig {
  param: string;
  label?: string;
  valuesPath?: string;
  valueField?: string;
  labelField?: string;
  countField?: string;
  dependsOn?: string;
}

export interface ExpressConfig {
  path: string;
  matchField?: string;
  keyField?: string;
  labelField?: string;
  subtitleField?: string;
}

export interface CatalogConfig {
  list: string;
  service?: string;
  idField?: string;
  titleField?: string;
  optionsField?: string;
  searchParam?: string;
  pageParam?: string;
  pageSizeParam?: string;
  priceUnit?: string;
  facets?: Array<FacetConfig | string>;
  express?: ExpressConfig;
  fields?: { service?: string; option?: string; quantity?: string; posts?: string };
}

export interface WalletAuthConfig {
  challenge: string;
  token: string;
  tokenField?: string;
  balanceField?: string;
}

export interface OrdersConfig {
  list?: string;
  get?: string;
  idField?: string;
  balanceField?: string;
}

/** A preset as written in presets/*.json. Everything but the origin is optional. */
export interface Preset {
  id: string;
  name: string;
  origin: string;
  environment?: Environment;
  resource?: string;
  method?: string;
  mcp?: string;
  wellKnown?: string;
  facilitator?: string;
  sampleBody?: Record<string, unknown>;
  catalog?: CatalogConfig;
  /** The recipient this source has always paid to, per CAIP-2 network. */
  knownPayTo?: Record<string, string>;
  walletAuth?: WalletAuthConfig;
  orders?: OrdersConfig;
  notes?: string;
}

/** The source the page is pointed at: a preset with every default filled in. */
export interface Target {
  id: string;
  name: string;
  origin: string;
  environment: Environment;
  resource: string;
  method: string;
  mcp: string;
  wellKnown: string;
  facilitator: string;
  sampleBody: Record<string, unknown>;
  catalog: CatalogConfig | null;
  knownPayTo: Record<string, string> | null;
  walletAuth: WalletAuthConfig | null;
  orders: OrdersConfig | null;
  notes: string;
}

export function targetFromPreset(preset: Preset): Target {
  return {
    id: preset.id,
    name: preset.name,
    origin: preset.origin,
    environment: preset.environment ?? "unknown",
    resource: preset.resource ?? "/",
    method: preset.method ?? "POST",
    mcp: preset.mcp ?? "",
    wellKnown: preset.wellKnown ?? "/.well-known/x402",
    facilitator: preset.facilitator ?? "",
    sampleBody: preset.sampleBody ?? {},
    catalog: preset.catalog ?? null,
    knownPayTo: preset.knownPayTo ?? null,
    walletAuth: preset.walletAuth ?? null,
    orders: preset.orders ?? null,
    notes: preset.notes ?? "",
  };
}

/** What the local server hands the page at /config. */
export interface LabConfig {
  token: string;
  presets: Preset[];
  allowedOrigins: string[];
  version?: string;
}

/** The limits a person sets on a payment, kept per source. */
export interface Guards {
  /** The most this tab may sign for, as a decimal string in the asset's units. */
  maxSpend: string;
  /** A recipient to hold every quote to. Empty means "use what the preset ships knowing". */
  expectedPayTo: string;
}
