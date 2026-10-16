# Michi user guide

This is the human entry point to the same canonical Markdown used by the built-in `michi_docs` tool. General content was source-reviewed on October 16, 2026. Each article states its scope; native Runtime versions and provider access can differ. Crew's guide retains its dated acceptance record.

Start with [Getting started](../backend/src/docs/getting-started.md) to complete a small task. For a problem, open [Troubleshooting](../backend/src/docs/troubleshooting.md). Public source installations use `~/Michi`, with application state under `~/.michi`; project folders and developer checkouts can be elsewhere.

| Guide | What it covers | Built-in document ID |
| --- | --- | --- |
| [Find help](../backend/src/docs/help.md) | Topic routing, Agent lookup and evidence boundaries | `help` |
| [Getting started](../backend/src/docs/getting-started.md) | Launch, backend/workspace, Runtime and first verified task | `getting-started` |
| [Concepts and context](../backend/src/docs/concepts-and-context.md) | Trees, panes, branches, history, references and Memory | `concepts-and-context` |
| [Common workflows](../backend/src/docs/common-workflows.md) | Research, implementation, review and handoff | `common-workflows` |
| [Choose a Runtime](../backend/src/docs/runtimes.md) | Requirements, authentication and models | `runtimes` |
| [Runtime capabilities](../backend/src/docs/runtime-capabilities.md) | Integration matrix, native features and limits | `runtime-capabilities` |
| [Permissions](../backend/src/docs/permissions.md) | Ask/Trust/YOLO, grant scope, revocation and sandbox | `permissions` |
| [Sessions and recovery](../backend/src/docs/sessions-and-recovery.md) | Execution state, queue/steer, Stop, resume and fork | `sessions-and-recovery` |
| [Files and Artifacts](../backend/src/docs/files-and-artifacts.md) | Files, attachments, references, remote paths and browser | `files-and-artifacts` |
| [Data and backups](../backend/src/docs/data-and-backups.md) | Archive/Trash, export, backup, restore and migration | `data-and-backups` |
| [Configuration](../backend/src/docs/configuration.md) | Settings timing, CLI PATH, credentials, environment and updates | `configuration` |
| [Performance and usage](../backend/src/docs/performance-and-usage.md) | Latency diagnosis, context, tokens and billing | `performance-and-usage` |
| [Privacy and data](../backend/src/docs/privacy-and-data.md) | Storage, recipients, authentication, telemetry and deletion | `privacy-and-data` |
| [Troubleshooting](../backend/src/docs/troubleshooting.md) | Symptom index, diagnostic steps and a redacted report template | `troubleshooting` |
| [Custom Agents (experimental)](../backend/src/docs/custom-agents.md) | Definitions, Runs, watches, policy and results; disabled by default | `custom-agents` |
| [KiroCrew setup](../backend/src/agents/crew/GETTING_STARTED.md) | Required App/MCP/sessionApproval, Sync, Memory and acceptance scope | `crew` |
| [Remote backend setup](remote-backend.md) | Launch, SSH, connection tokens and lifecycle | `remote-backend` |

## Use the guide with an agent

Ask: “Consult Michi's built-in docs and explain how to recover this chat. Check the actual state before taking action.” The agent can list/search/read the documents on demand. The tool returns line numbers and content fingerprints, not live diagnostic state. See the help article for pagination and query examples.

If MCP/tool discovery is broken, these Markdown files remain directly readable in a source installation or repository. A built backend also includes its public copies under `backend/dist/docs/`. Do not rely on the missing tool as the only help path.

## Content maintenance and verification

The catalog at `backend/src/docs/catalog.json` selects the public source files. Backend packaging copies them to `dist/docs/<document-id>.md`. In the built corpus, related-topic references use stable document IDs so that a source-relative path is not mistaken for a packaged path.

Edit canonical sources, then regenerate any documentation exports from them. Do not independently maintain a second copy of setup instructions or convert a source-reviewed statement into a real-provider verification claim.

For content changes, check commands/UI labels and applicability against current implementation, verify guide links and catalog IDs, and exercise representative retrieval queries when changing the catalog. Native feature claims require dated provider/engine/platform evidence if advertised as tested.

The research that informed this organization used [Claude Code workflows](https://code.claude.com/docs/en/common-workflows), [Claude Code memory](https://code.claude.com/docs/en/memory), [Cursor troubleshooting](https://prod.cursor.com/help/troubleshooting/agent-issues), [Kiro session management](https://kiro.dev/docs/cli/chat/session-management/), [Kiro context management](https://kiro.dev/docs/cli/chat/context/), [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) and [OpenAI Docs MCP](https://developers.openai.com/learn/docs-mcp). They inform documentation structure, not Michi feature guarantees.
