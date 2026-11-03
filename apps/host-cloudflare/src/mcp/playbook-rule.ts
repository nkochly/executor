/**
 * The playbook-first rule: before an agent starts a task, it looks for how the
 * team already does it. Executor, wiki_mcp and Muster each carry this exact
 * text at the start of their server instructions, so an agent hears the same
 * rule whichever server it meets first.
 *
 * The wording lives once per repository, here, and the three copies are held
 * equal by PLAYBOOK_RULE_SHA256: each repository's tests compare the text to
 * this digest. Changing the rule means changing the text and the digest in all
 * three repositories together.
 */
export const PLAYBOOK_RULE =
  "Look for the team's way first. Before you start a task, read the team's how-we-work page if there is one, " +
  "then search what the team has already written down about this kind of task, trying two or three phrasings. " +
  "Follow what you find. If nothing fits, do the task your own way and record what you did, so the next agent finds it.";

/** SHA-256 of PLAYBOOK_RULE, hex. The same value is pinned in wiki_mcp and Muster. */
export const PLAYBOOK_RULE_SHA256 =
  "d80b4e7f5c206b34c3e378a6626275331a4d44f99fc83b101ce74e720b52612c";
