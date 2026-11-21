# Glossary

The words for this repo's domain. Read it before any task. The shared core
below is copied byte for byte from `wiki_mcp/GLOSSARY.md`, the Trifecta
master, and `scripts/check-glossary.mjs` holds it there; never edit it here.
The Context section after it is this repo's own.

<!-- glossary-core:start -->
## Shared core

The Trifecta is several repos that run as one system: wiki_mcp, Muster,
microsite-kit, Executor, activity, wallflower, artifacts-quick, always-on-agent,
universe, lookout, and the CI repos. This core is the same, byte for
byte, in every repo's `GLOSSARY.md`. Its one source is `wiki_mcp/GLOSSARY.md`;
change it there and run `npm run glossary:sync` in wiki_mcp, which writes every
copy and the digest each repo's check holds it to. Never edit the core in a
copy.

How to use this file:

- Use the term this file defines for every concept it defines, in code,
  commit messages, docs, tool descriptions and replies. No synonyms.
- A new domain word goes into the glossary in the same pull request that
  introduces it: a shared word into the core (in wiki_mcp), a local word into
  this repo's own Context section below the core.
- A word may mean something narrower inside a Context section, never
  something different from the core.
- Renaming a database column, an API field or a tool name needs Nathan's
  explicit approval first. The "Code" lines below list every name a concept
  has today, so a mismatch is recorded, not hidden.
- Forks (Executor, wallflower, artifacts-quick) keep their
  upstream names in code; their Context sections map them to these terms.

Each entry gives the definition, what it is not, and the code that implements
it with every name it has today.

### Who and which team

- **tenant**: One team: an account manager and their extended team. Its slug
  is owned by wiki_mcp and is the same in every service. Say "team" where
  people read, "tenant" in code.
  *Not:* an organization, a Studio workspace, or an Access group.
  *Code:* wiki_mcp `src/control/d1.ts`, `src/federation/tenants.ts`; Muster
  `apps/muster/src/tenants.ts`; Executor `organizationId`.
- **member**: A person in a tenant, with the role `owner`, `admin` or
  `member`. Membership gives administrative rights, never read access.
  *Not:* a grant.
  *Code:* wiki_mcp `membership`; Muster `tenants.ts` role enum; Executor
  directory role.
- **operator**: A platform admin of every Trifecta service.
  *Not:* a tenant owner or admin.
  *Code:* `OPERATOR_EMAILS`; `GET /api/directory/operators/:subject`.
- **person**: A human behind a call, signed in with Webex through Cloudflare
  Access.
  *Not:* a subject string, or an agent.
  *Code:* `via.person`; Muster principal for people.
- **agent**: Software acting for a tenant or a person, signed in with a
  service token.
  *Not:* a person, or a connector.
  *Code:* `svc:<name>`; `via.agent`.
- **subject**: The identity string Cloudflare Access gives a caller: an email
  or `svc:<name>`.
  *Not:* a principal (in Muster a principal is a subject plus its
  capabilities).
  *Code:* wiki_mcp `src/worker/identity.ts`; Muster
  `apps/muster/src/auth/access.ts` (`principal`).
- **grant**: Permission for a subject or a group on one wiki or one Muster
  project. The only thing that makes either readable.
  *Not:* tenant membership.
  *Code:* wiki_mcp `wiki_grant` (`reader`, `maintainer`); Muster grants and
  capabilities.
- **customer account**: One customer the team sells to, named by one
  kebab-case slug.
  *Not:* a sign-in, a connection, or a Cloudflare account.
  *Code:* wiki_mcp `src/okf/accounts.ts`, `list_accounts`, top-level folder
  `{account}/`; microsite-kit `customer` (`control/src/customers.ts`).
- **attribution**: The stamp of client, person, agent and guide that
  Executor puts on every call. A label beside the authenticated author, never
  used for access.
  *Not:* identity, or a permission.
  *Code:* request `_meta` key `dev.presidio-west/attribution`; wiki_mcp and
  Muster `src/attribution.ts`; stored as `via`.

### Tools and connections (Executor)

Executor is a fork whose own `GLOSSARY.md` carries only its upstream words.
These are the Trifecta's names for what agents meet through it.

- **app**: A package of tools Executor hosts, reached as `tools.<slug>.*`,
  such as `wiki-{TENANT}`.
  *Not:* a connector, or an Access application.
  *Code:* Executor v2 apps; v1 `integration`.
- **connection**: One signed-in link from Executor to an outside service. A
  team connection is shared by a tenant; a personal connection belongs to one
  person.
  *Not:* a customer account.
  *Code:* Executor `packages/core/sdk/src/connection.ts`; `accountId` on app
  calls; "workspace connection" means team connection.
- **toolkit**: A named subset of tools for one connection. It narrows, never
  widens.
  *Not:* an app.
  *Code:* Executor `packages/plugins/toolkits`.
- **connector**: The entry in Claude or AI Studio that points at an MCP
  server such as Executor.
  *Not:* an app, or a connection.
  *Code:* Studio and Claude settings.
- **guide**: How to use one server's tools, served by that server as a skill.
  *Not:* the team's playbook page, or a Garden skill.
  *Code:* the `guides` tool in wiki_mcp and Muster;
  `skill://wiki/<name>/SKILL.md`.
- **agent report**: What an agent sends when a tool it reached through
  Executor gets in its way: the tool, what it sent, what came back, what it
  expected and the fix it proposes. Executor's `feedback.submit` hands it to
  the intake, which files it as a standing beta task labelled
  `agent-report`, or adds it to the open task it repeats.
  *Not:* beta feedback (a person's words in the Webex space), an alert (a
  lookout check), or a finding (a fact on a task).
  *Code:* Executor `feedback.submit` (`apps/hosted/cloudflare/src/agent-reports.ts`,
  `feedback.md`); Muster `apps/feedback/src/agent-report.ts` (`AgentReports`).

### Decision models

- **decision model**: An AI model that answers typed questions about some
  text with a probability for each allowed answer, and writes no text. Jev
  (TypeSafe) is one, reached through the AI Gateway that holds its key.
  *Not:* a language model, a rule, or a person's approval.
  *Code:* wiki_mcp `src/judgment/jev.ts` (`askJev`, `JEV_VERSION`), mirrored
  in Muster `packages/judgment`; always-on-agent `src/agent/jev.ts`;
  microsite-kit `control/src/policy.ts`.
- **judgment**: One named question a service asks a decision model, with the
  threshold it acts at and what happens when there is no answer. A judgment
  may warn, rank, sort or make a rule stricter; it never opens a gate, sets a
  status or replaces a person's approval. Each answer is one entry in that
  service's judgment log.
  *Not:* a decision (the model judges; a person or a rule decides), a
  finding, a diagnostic, or an approval.
  *Code:* `JudgmentRecord`; wiki_mcp `src/judgment/note-orders.ts`
  (`note_gives_orders`) and `src/links/suggest.ts`; Muster
  `apps/muster/src/judgment/` and `judgment_log`, `apps/feedback/src/sort.ts`
  (`sort_feedback`). always-on-agent calls these "Jev checks", microsite-kit
  "findings".
- **AI Gateway**: The Cloudflare gateway every model call of every Trifecta
  service goes through. It holds the Jev key, logs each call and enforces the
  spend limits; a service with no gateway makes no model call. One for now,
  `jev-test`.
  *Not:* Executor, which write attribution (`via`) also calls a gateway, or
  Cloudflare Gateway (Zero Trust).
  *Code:* the Trifecta stack's `AiGateway` (`trifecta/alchemy.run.ts`,
  `viaAiGateway`); `AI_GATEWAY_ID` and `AI_GATEWAY_SERVICE` in each Worker;
  wiki_mcp `gatewayOptions` in `src/judgment/jev.ts`.
- **spend limit**: A dollar budget per sliding day that the AI Gateway holds:
  one for the whole gateway and one for each service. Over it, the gateway
  refuses calls with a 429 until the window has room.
  *Not:* a write budget, a rate limit, or any budget kept in our own code.
  *Code:* `aiSpendPerDay` in `trifecta/stages.ts`; always-on-agent
  `src/agent/spend-guard.ts` tells the person when one trips.

### The universe

- **universe**: One team's wiki pages and Muster tasks drawn as one
  read-only 3D picture, as the signed-in person's own grants let them read.
  The team is at the centre, its customer accounts and projects orbit it,
  and each page and task orbits its customer account or project. It writes
  nothing and decides nothing: every act opens the Muster app, and what
  changed over time stays in Activity's feed.
  *Not:* a dashboard of counts, a status view, a second task screen, or a
  wiki. Never "galaxy", "map" or "graph".
  *Code:* repo `universe` (`Universe` in `src/model/universe.ts`), Worker
  and package `universe`, host `universe.<domain>`.
- **tour**: The universe moving itself from the team to each customer
  account and project, then to each hold, until a key or click ends it.
  *Not:* onboarding, a walkthrough of the app, or a presentation (that is
  wallflower's presenter).
  *Code:* universe `tourStops`, `touring` (`src/client/ui/App.tsx`), key `T`.

### Keeping data safe

- **backup**: A daily copy of one Durable Object's data (its tables and
  stored values) in its service's own US R2 bucket, written by the object
  itself within a day of a change and proven readable by a restore test. The
  newest one of each object is kept; older ones go after 30 days.
  *Not:* D1 Time Travel, a Durable Object's own 30-day point-in-time
  recovery, the wiki's rebuild from R2, or always-on-agent's memory backups.
  *Code:* wiki_mcp `src/backup/backup.ts` (`writeBackup`), copy of record,
  mirrored into Muster and wallflower; Executor v2
  `@executor-js/hosted-cloudflare/backup`, the same format; buckets `muster-backups`,
  `wallflower-backups`, `executor-v2-backups`.
- **restore**: Writing a backup into a Durable Object that holds no data of
  its service, in one transaction. It never writes over a live object.
  *Not:* a note restore (a maintainer putting back a deleted note), taking a
  Muster task out of the archive, or a D1 Time Travel restore.
  *Code:* `restoreInto` in `src/backup/backup.ts` and its mirrors; each
  service's operator restore route.

### The lookout

- **lookout**: The Worker that checks every Trifecta service on a schedule
  with fixed rules, no decision model anywhere, and raises an alert when a
  check fails. It reads health routes and records and writes nothing but
  alerts.
  *Not:* AgentJobCheck (that runs only during a deploy), the hourly sweep
  (that is an agent), or a judgment.
  *Code:* repo `lookout` (`runChecks` in `src/checks.ts`), Worker and
  package `lookout`.
- **alert**: One failing lookout check. It is reported once on a beta Muster
  task, with a Webex message to the stage's admin, and closes when the check
  passes again: a comment on that task and one more message. A check that
  fails again while its last alert's task is still open is reported as a
  comment on that task, not a new one. An alert about a stuck task files no
  task and closes without a message. The lookout never closes a task. Full
  lifecycle: lookout decision record 0001.
  *Not:* a finding, a judgment, a diagnostic or a filing.
  *Code:* lookout `Alert` (`src/alerts.ts`).

### The live check

- **live check**: One opening of a deployed Trifecta page in Chromium on
  the deploy's CI runner, through Cloudflare Access with a service token the
  runner adds at egress, so the token never enters the container. It records
  the HTTP status, a screenshot and the console errors, and fails the deploy
  on a bad page.
  *Not:* a lookout check (scheduled, fixed rules, no browser),
  AgentJobCheck (a Muster job over MCP, no browser), or a wiki page.
  *Code:* wiki_mcp `trifecta/ci/live-check.mjs`, stage setting `liveCheck`;
  each checked service's `LIVE_CHECK_CLIENT_ID`.

### How the repos are built

- **shared rules**: The coding rules every Trifecta repo follows, written
  once as a marked block in the wiki_mcp repo's `CLAUDE.md` and copied byte
  for byte into each repo's `CLAUDE.md` by `glossary:sync`.
  *Not:* the shared core of this glossary (words, not rules), a repo's
  `REVIEW.md`, a repo's own `CLAUDE.md` lines outside the block, or anything
  stored in a wiki.
  *Code:* wiki_mcp `CLAUDE.md` between `<!-- shared-rules:start -->` and
  `<!-- shared-rules:end -->`; `tools/glossary-sync.mjs` (`rulesBlock`);
  each repo's `scripts/check-glossary.mjs`.
- **solution note**: A short Markdown file in a repo's `docs/solutions/`
  holding a lesson no test or rule can hold (a rejected approach, a measured
  fact), read at the start of a build thread. The last place a lesson goes under
  the shared rules' "Cheapest form first".
  *Not:* a `CLAUDE.md` line, a project memory line, a Muster finding, a
  wiki note, or a plan.
  *Code:* `docs/solutions/*.md` in each repo; the "Solution notes" line of
  the shared rules.
- **decision record**: A numbered Markdown file in a repo's `docs/adr/`
  that records one important, non-obvious decision about the code: what was
  decided, why, and what it governs. Where the reasoning a code comment once
  held now lives.
  *Not:* a solution note (a lesson from a wrong belief), a code comment, a
  plan, a Muster finding, or a wiki note.
  *Code:* `docs/adr/NNNN-*.md` in each repo; the "No code comments" and "SDK
  first" lines of the shared rules.
- **comment ratchet**: The check that holds every file of a repo to the
  number of code comment lines its baseline allows, a number that may only go
  down. Lint and type directives, shebangs and license headers are not
  counted.
  *Not:* a comment on a Muster task, a lint directive, or a test snapshot.
  *Code:* `scripts/comment-ratchet.mjs` (copy of record in gh-ci-templates,
  written into every repo by `glossary:sync`); each repo's
  `.comment-baseline.json`; the `delete-comment` skill
  (`.claude/skills/delete-comment/SKILL.md`).

### Bounded contexts

Each repo owns the words for its own job. The shared core above is owned by
wiki_mcp, which owns tenants.

| Context | Repo | Words it owns |
| --- | --- | --- |
| Shared core | wiki_mcp, used by all | tenant, member, operator, person, agent, subject, grant, customer account, attribution, backup, restore, shared rules, solution note, decision record, comment ratchet |
| Work | Muster | project, task, status, pause, hold, task claim, review, finding, phase |
| Knowledge | wiki_mcp | wiki, note, page, source, cited claim, proposal, promotion, drift, type, vocabulary |
| Tools and connections | Executor | app, connection, toolkit, connector, policy, integration, secret |
| Customer sites | microsite-kit | site, door, publish, approval, invite, invitee, design |
| Boards | wallflower | board, card, group, frame, presenter |
| Shared documents | artifacts-quick | document, link, seal |
| Activity | activity | change, change log, feed |
| Universe | universe | universe, tour |
| Watching | lookout | lookout, alert |
| Lab: one person's agent | always-on-agent | channel, schedule, to-do, workspace folder, memory |
| CI and look | cf-github-runners, gh-ci-templates, presidio-ui | runner, approval, stage, token |

"Claim" is two things on purpose: a Muster lease and a wiki statement. Always
qualify it: **task claim** or **cited claim**.

### Words to avoid everywhere

- "organization" or "org": say tenant.
- "account" alone: say customer account, connection, or Cloudflare account.
- "workspace" alone: say Studio workspace or workspace folder.
- "artifact" alone: say Claude page, artifacts-quick document, or Executor
  artifact.
- "board" for Muster: a view of tasks by status is a status view.
- wiki_mcp's retired words for work: item, agenda, hold (in the wiki), take,
  settle, drop, triage. Work and its words are Muster's.
<!-- glossary-core:end -->

## Context: Executor (executor)

Executor's own domain words (provider, account, app, version and the rest)
are upstream's, in `CONTEXT.md`. Where a word is in both, `CONTEXT.md` wins
inside this repo. A new domain word for fork-owned code goes into `CONTEXT.md`
in the pull request that introduces it.
