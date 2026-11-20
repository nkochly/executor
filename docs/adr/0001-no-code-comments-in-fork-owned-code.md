# 0001. No code comments in fork-owned code

Date: 2026-11-20. Status: accepted.

## Context

Code comments in this fork had drifted into four kinds: tautologies that repeated the code, stale
notes about code that had changed, excuses that let a hacky implementation stand, and decision
records. Only the last kind is worth keeping, and it is easier to find, review and keep true in one
place than scattered beside the code it governs.

This repository is a fork of upstream Executor and ports upstream's fixes from upstream's own
commits. Deleting code comments in upstream's files would make every later port conflict.

## Decision

- Fork-owned code carries no code comments. Fork-owned code is every code file in neither
  upstream's `v2` branch nor the commit the fork started from (`git merge-base HEAD upstream/v2`).
- A decision goes in a decision record under `docs/adr/`. An excuse becomes a beta Muster task to
  fix the implementation. A tautology or stale code comment is deleted.
- The comment ratchet (`scripts/comment-ratchet.mjs`, synced from gh-ci-templates) enforces it
  against `.comment-baseline.json`: a file may hold at most the code comments its baseline allows,
  and `--update` only lowers counts. Upstream's files are listed under `ignore`.
- Exempt (as the delete-comment skill applies it): directives (`@ts-expect-error`, `/// <reference>`, lint and coverage pragmas,
  `#__PURE__`, `@vitest-environment`, `@jsx`), a license header at the top of a file, and generated
  files (`@generated`, `DO NOT EDIT`).
- Upstream's files are out of scope and keep their code comments. Code comments the fork added
  inside upstream's files are also left for now, so the fork's diff against upstream stays the
  same size.
- `.claude/skills/delete-comment/SKILL.md` repeats the process.

## Consequences

- The first pass removed every code comment from fork-owned code: 518 code comments, 1,191 lines.
- A new upstream file brought in by a port must be added to `ignore`, or the comment ratchet
  fails on its code comments.
- A file the fork copies from upstream under a new path is fork-owned and must lose its code
  comments.
