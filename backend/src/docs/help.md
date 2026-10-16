# Find Michi help

Applies to: bundled product documentation served by the current backend. Source checked: 2026-10-16. The general guides were reviewed against current source. The Crew guide records its own dated real-provider/version/platform acceptance; those tests were not rerun for this documentation expansion.

## Choose a document

| Document ID | Use it when |
| --- | --- |
| `getting-started` | Installing/launching and completing the first task |
| `concepts-and-context` | Understanding trees, branches, references, instructions and Memory |
| `common-workflows` | Researching alternatives, implementing, reviewing and handing off |
| `runtimes` | Choosing/configuring Kiro CLI, Crew, Pi, Claude or Codex |
| `runtime-capabilities` | Comparing supported integration behavior and limits |
| `permissions` | Choosing Ask/Trust/YOLO or understanding approval grants |
| `sessions-and-recovery` | Queueing, steering, Stop, reconnection, resume and fork |
| `files-and-artifacts` | Finding files, uploading attachments, reusing sources and viewing websites |
| `data-and-backups` | Recovering history, deletion, export, backup and migration |
| `configuration` | Settings scope, authentication, CLI paths, environment and updates |
| `performance-and-usage` | Slow responses, context, reasoning and usage/billing distinctions |
| `privacy-and-data` | Data locations, external recipients, logs and external recipients |
| `troubleshooting` | Finding an error/symptom and gathering useful evidence |
| `custom-agents` | Experimental definitions, Runs, permissions and watches |
| `crew` | Required Crew App/MCP/sessionApproval setup, Sync and Memory |
| `remote-backend` | Remote launch, SSH, tokens and backend lifecycle |

## Ask a question

Useful prompts:

- “Use Michi's docs to explain what a branch inherits and whether it isolates files.”
- “Check the documented approval modes, then inspect which mode my chat actually uses.”
- “My stream returned 410. Consult the docs, check the original task state and avoid duplicating work.”
- “Read the backup guide and explain what I need to preserve before moving machines.”

If the tool is unavailable, open the repository/installation's `docs/user-guide.md`, or the public repository. A source installation keeps canonical Markdown files under `backend/src/docs/`; built backends carry flattened public documents under `backend/dist/docs/`. Crew and remote setup have their own canonical source files; the human guide links them.

## Agent lookup procedure

1. Call `michi_docs` with action `list` to discover valid IDs.
2. Search a short topic, error string or indexed alias, then read the selected document. Search is keyword matching, not general semantic question answering; if a full sentence finds nothing, shorten it or list the index.
3. Continue from `nextStartLine` if the relevant text is on another page. Read the conditions and adjacent limitations, not only one search snippet.
4. Cite document ID and lines when answering; distinguish the documented rule from inspected live state.

Conceptual argument examples:

```json
{"action":"search","query":"turn_active"}
{"action":"read","docId":"sessions-and-recovery","startLine":1,"limit":80}
```

Use the actual tool schema. MCP variants can require the current issued `session_id`; use only that identity, never another session's ID or an invented endpoint.

Reads default to 80 lines, allow at most 160 and cap output at 16,000 bytes. Searches default to five results and allow at most ten. Queries are limited to 200 characters. Document IDs are catalogued references; file paths and URLs are not accepted as `docId`.

## Versions and evidence

`contentVersion` and `docsVersion` are content fingerprints. They identify the text returned by this backend, not a semantic app version or proof of provider compatibility. Read each article's applicability/review statement and the native runtime's actual version.

Bundled docs work offline and are public product references. They do not inspect credentials, running processes, current permissions, account balances or private conversations. They do not grant authorization to change those things.

Supported, conditional, unavailable and experimental are distinct. The presence of a control/schema does not prove live execution. If a diagnosis requires logs/settings, inspect them with appropriate tools and disclose what remains unknown. Redact credentials and private content when reporting a problem.

Related documents: `getting-started`, `troubleshooting`, `runtime-capabilities`, `privacy-and-data`.
