# Glossary

The words for Executor's domain. Use the term defined here for every concept
it defines, in code, comments, docs and tool descriptions; a new domain word
goes into this file in the pull request that introduces it. Each entry gives
the definition, what it is not, and where it lives. `vision.md` explains why
the model is shaped this way.

## Core

- **tool**: An id with optional input and output schemas; the unit of
  capability. Addressed as `<integration>.<scope>.<connection>.<tool>`.
  _Not:_ an integration.
- **integration**: A set of tools a plugin produces from some config (an
  OpenAPI spec, a GraphQL endpoint, an MCP server, a CLI). The core sees only
  its normalized manifest.
  _Not:_ a connection.
  _Code:_ `packages/core/sdk/src/integration.ts`.
- **connection**: The saved credential for exactly one integration, named
  and owner-scoped, identified by `(scope, integration, name)`. Its name is
  load-bearing (`work`, `personal`, `prod`). One integration holds many
  connections.
  _Not:_ a secret value, or an integration.
  _Code:_ `packages/core/sdk/src/connection.ts`.
- **secret**: A credential value. It never lives in Executor and never
  reaches the agent: a connection holds a reference, and a provider resolves
  it at call time.
  _Not:_ a connection.
  _Code:_ `packages/plugins/*-secrets`, `packages/core/sdk/src/provider.ts`.
- **provider**: The backend that resolves a connection's secret, such as the
  default store or 1Password.
  _Not:_ the outside service an integration calls.
  _Code:_ `packages/core/sdk/src/provider.ts`.
- **scope**: Placement and identity: an ordered, merged set from outer
  (authority) to inner (actor). Every record is placed in a scope. Today the
  set has two entries, organization and user.
  _Not:_ an OAuth scope.
  _Code:_ `Owner` (`org`, `user`) in `packages/core/sdk/src/ids.ts`.
- **organization**: The outer scope: the group of people who share
  integrations, connections and policies.
  _Not:_ a user.
  _Code:_ `Owner` `org`; `organizationId`.
- **policy**: A rule that gates execution: allow, require approval, or
  block. Attached to integrations and connections; an outer scope's block
  cannot be weakened inward.
  _Not:_ a toolkit.
  _Code:_ `packages/core/sdk/src/policies.ts`.
- **toolkit**: A named, ordered set of policy rules over tools, which
  narrows what a caller may reach and never widens it.
  _Not:_ an integration.
  _Code:_ `packages/plugins/toolkits`.
- **plugin**: What registers integrations, tools, providers, storage and
  surfaces. The one open extension seam is integrations.
  _Not:_ a first-party capability.
  _Code:_ `packages/core/sdk/src/plugin.ts`, `packages/plugins/*`.
- **surface**: How an executor is reached over a wire: MCP, HTTP, CLI,
  stdio, triggers, the web app.
  _Not:_ what is built (a tool, view or workflow).
  _Code:_ `packages/hosts/*`, `apps/*`.
- **artifact**: A rich output a call produces and a client renders or opens
  later.
  _Not:_ a tool.
  _Code:_ `packages/core/sdk/src/artifact.ts`.
