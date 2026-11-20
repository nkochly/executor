import { Schema } from "effect";

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
export const TokenError = Schema.Literals([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_target",
]);
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
export const oauthErrorCodes: ReadonlyArray<string> = [
  ...KnownError.literals,
  ...TokenError.literals,
  ...RegistrationError.literals,
];
