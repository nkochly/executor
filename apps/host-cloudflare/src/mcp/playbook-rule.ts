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
  "Look for the team's way first. Before you start a piece of work, read the team's how-we-work page if there is one " +
  "and search once for what the team has already written about it. " +
  "Follow what you find. If nothing fits, do it your own way and record what you did, so the next agent finds it. " +
  "Skip this for quick asks such as tracking, listing or updating a task.";

/** SHA-256 of PLAYBOOK_RULE, hex. The same value is pinned in wiki_mcp and Muster. */
export const PLAYBOOK_RULE_SHA256 =
  "9fc5660d919d4b12188e0baa85f5330dc2e0b559d2279fdc9b277e0115e7b173";
