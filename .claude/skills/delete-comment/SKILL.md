---
name: delete-comment
description: Delete code comments from this fork's own code, moving each decision into a decision record. Use when asked to remove, audit or clean up code comments, or when the comment ratchet fails.
---

# Delete code comments

This repository is a fork of upstream Executor. Only fork-owned code is cleaned: files in neither
upstream's `v2` branch nor the commit the fork started from. Upstream's files keep their code
comments, so ports from upstream stay clean. `docs/adr/0001-no-code-comments-in-fork-owned-code.md`
holds the rule.

## 1. Find the fork-owned files

```sh
git remote add upstream https://github.com/UsefulSoftwareCo/executor 2>/dev/null
git fetch upstream v2
base=$(git merge-base HEAD upstream/v2)
git ls-files | grep -E '\.(c|m)?(j|t)sx?$|\.(jsonc|css|html?|ya?ml|sh|bash|toml|py|sql)$' > /tmp/here
{ git ls-tree -r --name-only upstream/v2; git ls-tree -r --name-only "$base"; } | sort -u > /tmp/upstream
grep -vxFf /tmp/upstream /tmp/here
```

Check the result against `only` in `.comment-baseline.json`, which lists every fork-owned file the
comment ratchet scans (code, `.jsonc`, `.yml`, `.toml` and the other kinds it reads). Add any
fork-owned file missing from it.

## 2. List every code comment

`node scripts/comment-ratchet.mjs --report` lists the code comments the comment ratchet counts in
scope. Directives (`@ts-expect-error`, `/// <reference>`, lint pragmas, `#__PURE__`), a license
header and generated files are exempt; leave them.

## 3. Categorise each code comment

Read each one beside the code it sits on.

- **Tautology**: says what the code already shows (a name restated, a step narrated). Delete it.
- **Stale**: names code, behaviour or history that is no longer true, or a past state ("as
  before", "Executor v1"). Delete it.
- **Excuse**: lets a hacky implementation stand (a swallowed error, a stub module, a fixed sleep in
  a test, matching an error by message text). Delete it and file a beta Muster task through the
  Executor app `muster-beta` naming the file, the hack and the fix.
- **Decision record**: an important, non-obvious decision (a platform limit, a security boundary,
  an ordering that matters, why one approach over another). Move it into the decision record in
  `docs/adr/` that covers the module, or a new `NNNN-<subject>.md` with Context, Decision and
  Consequences, and add it to `docs/adr/README.md`. Write the decision, not the history.

## 4. Delete

Delete only code comments, never code. Remove a code comment's whole lines when it stands alone,
and only the code comment when it trails code. Then run `bun run format` on the changed files and
`bun run lint`. Confirm each file's tokens are unchanged apart from code comments (a TypeScript
scanner comparison is the quickest proof).

## 5. Lower the code comment baseline

`node scripts/comment-ratchet.mjs --update` lowers each file's count in `.comment-baseline.json`;
it never raises one. Commit the deletions, the decision records and the baseline together, with no
AI attribution (`AGENTS.md`).

## 6. Report

Give counts per category, lines shed now, lines left in fork-owned code and in the whole
repository (`--report`), and the Muster tasks filed.
