import type { McpCallMetaInput } from "@executor-js/plugin-mcp";

// ---------------------------------------------------------------------------
// Write attribution for first-party servers (wiki, Muster). A workspace
// connection reaches them as the tenant's shared team agent, so their own
// records name only that agent. Every call this session makes to one of them
// also carries, in request `_meta`, who is behind it: the client app that
// connected to Executor, the person signed in, the agent (toolkit) and the
// last guide the session read from a first-party `guides` tool.
//
// A label only. The servers record it beside the author they authenticated
// and never consult it for access.
// ---------------------------------------------------------------------------

/** The request `_meta` key wiki and Muster read the stamp from. */
export const ATTRIBUTION_META_KEY = "dev.presidio-west/attribution";

/** What one call carries. Every field is optional; an empty stamp is not sent. */
export interface Attribution {
  readonly client?: string;
  readonly person?: string;
  readonly agent?: string;
  readonly guide?: string;
}

export interface AttributionSource {
  /** Origins (`https://host`) of the first-party servers. Nothing else is stamped. */
  readonly origins: readonly string[];
  /** The client's `initialize` info, read at call time (null before it). */
  readonly client: () => { readonly name: string; readonly version?: string } | undefined;
  readonly person: () => string | undefined;
  readonly agent?: string;
}

const MAX_FIELD = 200;

const field = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_FIELD) : undefined;
};

const originOf = (endpoint: string): string | null =>
  URL.canParse(endpoint) ? new URL(endpoint).origin : null;

/**
 * The plugin's `callMeta` hook for one session. It holds the session's last
 * guide, so build one per session, never per isolate.
 */
export const makeAttributionMeta = (source: AttributionSource) => {
  const origins = new Set(source.origins.map(originOf).filter((o): o is string => o !== null));
  let guide: string | undefined;

  return (call: McpCallMetaInput): Record<string, unknown> | undefined => {
    const origin = originOf(call.endpoint);
    if (origin === null || !origins.has(origin)) return undefined;

    if (call.toolName === "guides" && typeof call.args === "object" && call.args !== null) {
      const name = (call.args as { readonly name?: unknown }).name;
      if (typeof name === "string" && name.trim()) guide = field(name);
    }

    const info = source.client();
    const stamp: Attribution = {
      ...(info && field(info.name)
        ? { client: field(info.version ? `${info.name} ${info.version}` : info.name) }
        : {}),
      ...(field(source.person()) ? { person: field(source.person()) } : {}),
      ...(field(source.agent) ? { agent: field(source.agent) } : {}),
      ...(guide ? { guide } : {}),
    };
    return Object.keys(stamp).length === 0 ? undefined : { [ATTRIBUTION_META_KEY]: stamp };
  };
};
