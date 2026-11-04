// ---------------------------------------------------------------------------
// OAuth popup result — the message shape exchanged between the popup window
// (opened during authorization) and the opener (the onboarding UI). Both the
// server-side HTML generator and the client-side popup opener agree on this
// shape so that success / failure can be communicated reliably via both
// `postMessage` and `BroadcastChannel`.
// ---------------------------------------------------------------------------

/** Message type literal used to identify our popup results. */
export const OAUTH_POPUP_MESSAGE_TYPE = "executor:oauth-result" as const;

/** localStorage key prefix for a sign-in that continues in the same window.
 *  The opener writes `<prefix><state>` = the next authorization URL; the
 *  callback page for `state`, on success, takes that URL and goes there instead
 *  of closing, so several connections that share one sign-in finish in one
 *  window from one click. */
export const OAUTH_CHAIN_STORAGE_PREFIX = "executor:oauth-chain:" as const;

export type OAuthPopupResult<TAuth> =
  | ({
      readonly type: typeof OAUTH_POPUP_MESSAGE_TYPE;
      readonly ok: true;
      readonly sessionId: string;
    } & TAuth)
  | {
      readonly type: typeof OAUTH_POPUP_MESSAGE_TYPE;
      readonly ok: false;
      readonly sessionId: string | null;
      /** Short user-facing summary. */
      readonly error: string;
      /** Full technical detail. Omitted when identical to `error`. */
      readonly errorDetails?: string;
    };

export const isOAuthPopupResult = <TAuth>(value: unknown): value is OAuthPopupResult<TAuth> =>
  typeof value === "object" &&
  value !== null &&
  (value as { type?: unknown }).type === OAUTH_POPUP_MESSAGE_TYPE;
