/**
 * What self-host adds to the shared security audit vocabulary: its sign-in endpoints. A person
 * signs in with a password, through single sign-on (Better Auth's social endpoints, which serve
 * the generic OAuth `sso` provider), or by creating an account at setup or from an invitation,
 * which signs them in too.
 */
import type { AuthAuditVocabulary } from "@executor-js/hosted-server";

export const selfHostAuthAudit: AuthAuditVocabulary = {
  signIns: {
    "/sign-in/email": "password",
    "/sign-in/social": "sso",
    "/callback/:id": "sso",
    "/self-host/setup": "setup",
    "/self-host/register": "invitation",
  },
};
