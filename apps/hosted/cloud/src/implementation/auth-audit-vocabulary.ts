/**
 * What Cloud adds to the shared security audit vocabulary: its sign-in endpoints (email codes,
 * social, passkeys, SSO and the v1 handoff) and its passkey plugin's failure codes.
 */
import { PASSKEY_ERROR_CODES } from "@better-auth/passkey";
import type { AuthAuditVocabulary } from "@executor-js/hosted-server";

export const cloudAuthAudit: AuthAuditVocabulary = {
  signIns: {
    "/sign-in/email-otp": "email_otp",
    "/sign-in/social": "social",
    "/callback/:id": "social",
    "/oauth-proxy-callback": "social",
    "/passkey/verify-authentication": "passkey",
    "/sign-in/sso": "sso",
    "/sso/callback": "sso",
    "/sso/callback/:providerId": "sso",
    "/sso/saml2/sp/acs/:providerId": "sso",
    "/v1-handoff/session": "v1_handoff",
  },
  failureCodes: Object.keys(PASSKEY_ERROR_CODES),
};
