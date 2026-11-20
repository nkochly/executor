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
