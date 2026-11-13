/**
 * The OAuth error codes Better Auth answers with: a sign-in's error redirect, the token endpoint
 * and client registration. Records that name an OAuth error accept only these.
 */
import { Schema } from "effect";

/** The errors a sign-in returns to the browser in its error redirect. */
export const KnownError = Schema.Literals([
  "access_denied",
  "state_not_found",
  "state_mismatch",
  "state_expired",
  "invalid_callback_request",
  "no_code",
  "oauth_provider_not_found",
  "issuer_missing",
  "issuer_mismatch",
  "nonce_binding_missing",
  "invalid_code",
  "unable_to_get_user_info",
  "no_callback_url",
  "unable_to_link_account",
  "account_not_linked",
  "email_does_not_match",
  "account_already_linked_to_different_user",
  "email_not_found",
  "email_not_verified",
  "unable_to_create_user",
  "unable_to_create_session",
  "signup_disabled",
]);
/** RFC 6749 token errors, and RFC 8707's for a resource the grant does not cover. */
export const TokenError = Schema.Literals([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_target",
]);
/** RFC 7591 registration errors, and the other OAuth codes Better Auth answers one with. */
export const RegistrationError = Schema.Literals([
  "invalid_client_metadata",
  "invalid_redirect_uri",
  "invalid_software_statement",
  "invalid_client",
  "invalid_request",
  "invalid_scope",
  "invalid_target",
  "access_denied",
]);
/**
 * Every OAuth error code Executor's sign-in returns, token endpoint and registration answer with.
 * Other records that name an OAuth error accept only these.
 */
export const oauthErrorCodes: ReadonlyArray<string> = [
  ...KnownError.literals,
  ...TokenError.literals,
  ...RegistrationError.literals,
];
