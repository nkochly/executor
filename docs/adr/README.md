# Decision records

A decision record holds one important, non-obvious decision about this fork's own code: what was
decided, why, and what follows. Fork-owned code carries no code comments
(the comment ratchet, `scripts/comment-ratchet.mjs`); a decision that once lived in a code comment lives here, named by the
module it governs.

Fork-owned code is every file that is in neither upstream Executor's `v2` branch nor the commit
this fork started from. Upstream's files keep upstream's code comments, so ports stay clean.

| Record                                                    | Subject                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| [0001](0001-no-code-comments-in-fork-owned-code.md)       | No code comments in fork-owned code                           |
| [0002](0002-executor-on-cloudflare-workers.md)            | Executor on stock Cloudflare Workers                          |
| [0003](0003-mcp-session-objects-and-isolated-programs.md) | MCP session objects and isolated programs                     |
| [0004](0004-product-location-and-backups.md)              | Product location, backups and restores                        |
| [0005](0005-cloudflare-storage-adapters.md)               | R2 blobs and Artifacts app source                             |
| [0006](0006-sqlite-on-durable-object-storage.md)          | SQLite on Durable Object storage                              |
| [0007](0007-one-trace-across-trifecta.md)                 | One trace across the Trifecta                                 |
| [0008](0008-sign-in-and-security-audit.md)                | Sign-in through Access, OAuth clients and the security audit  |
| [0009](0009-connection-bundles-and-person-apps.md)        | Connection bundles and the person's apps                      |
| [0010](0010-localhost-subdomains-in-e2e.md)               | Localhost subdomains resolve to loopback in e2e and apps      |
| [0011](0011-caller-label-on-mcp-calls.md)                 | Every MCP server an app calls hears which agent session calls |
| [0012](0012-native-approvals-as-input-required.md)        | Native approvals as input required on MCP 2026-07-28          |
| [0013](0013-app-skills-over-mcp-skills-extension.md)      | App skills over the MCP skills extension                      |
| [0014](0014-long-native-calls-as-mcp-tasks.md)            | Long native calls as MCP tasks                                |
