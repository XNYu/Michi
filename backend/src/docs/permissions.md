# Permissions and tool approvals

Applies to: ordinary chats on local/remote backends; hosted settings are owner-scoped. Source checked: 2026-10-16. Agent Runs use their own effective policy. Native sandbox and governance behavior depends on the runtime.

## Choose the mode in Michi

Open Settings → Model → Permissions. Use global permissions applies one mode to ordinary chats on that backend and hides per-chat composer controls. Turn it off to choose a mode in each chat. Individual choices are preserved while global control is enabled and restored when it is disabled. New chats default to Ask.

Kiro, Crew and Pi offer Ask / Trust in the composer. Claude and Codex also offer YOLO. Existing YOLO choices display as Trust on Kiro and Pi with the same execution behavior. Local and remote backends each own their settings; hosted settings are scoped to the authenticated user. Agent Runs have a separate permission policy.

## Ask, Trust and YOLO

- Ask: prompts for changes and tools requiring approval. Native read-only tools can run automatically. Pi also asks for unknown/external MCP tools. Reading bundled Michi docs is a read-only built-in operation.
- Trust: automatically approves tools while retaining any native sandbox. For example, Codex allows workspace writes but retains sandbox restrictions.
- YOLO: automatically approves tools and requests full native access where supported. Claude uses its bypass mode and Codex uses full access. Kiro/Pi Trust and YOLO have the same backend auto-approval behavior; Michi does not add an OS sandbox for them.

Changes apply from the next turn. Returning to Ask clears applicable Michi always-allow chat grants. Approval remains enforced without a connected renderer. Approval controls do not enable a missing tool or override an upstream governance refusal.

## Approval cards

- Deny rejects this request without saving a grant.
- Allow Once approves only this request.
- Trust this tool saves a grant for that tool in the current Michi chat and can survive resume. It is disabled when the runtime cannot identify the tool reliably.
- Trust all tools for this session trusts tools in the current runtime session. This grant is temporary, is not saved to the database and expires when the session is recreated or permission settings are explicitly changed.

Choose Ask again to clear applicable chat grants. Treat session-wide trust as temporary; a resumed native session may be recreated. A visible button or a saved mode does not prove that an upstream runtime produced a pending request.

| Choice | Saves a grant? | Survives session recreation? | Clears when |
| --- | --- | --- | --- |
| Deny | No | Not applicable | Request ends |
| Allow Once | No | No | Request ends |
| Trust this tool | Current-chat tool grant | Can survive resume | Applicable Ask reset clears it |
| Trust all tools for this session | Temporary session grant | No | Session recreation or explicit permission change |

With global permissions enabled, selecting Ask again clears the user's applicable chat tool grants; with per-chat mode it clears that chat's grants. Forks do not inherit those grants. Approval buttons are neutral until hover/focus; they have no dedicated shortcuts. Use click or keyboard focus plus Enter/Space.

## Approval and sandbox are different

| Runtime | Trust / full-access boundary |
| --- | --- |
| Kiro | Michi auto-approval; no added Michi OS sandbox; native policy still applies |
| Crew | Auto-answers pending native requests; Crew allowlists/governance still apply |
| Pi | Michi policy and filesystem path checks; arbitrary shell commands are not OS-isolated by a working directory |
| Claude | Native permission handling; YOLO uses native bypass; equivalent OS isolation is not verified by Michi |
| Codex | Trust retains native sandbox/workspace writes; YOLO requests full native access |

An approval decision authorizes the described request. It does not mean files can always be rolled back, credentials are valid, a tool is installed or an upstream service will allow the action.

## Test and diagnose an approval

1. Confirm runtime, backend, effective global/per-chat mode and tool availability.
2. In a disposable directory, ask for a small clearly identified write. Review the actual native request if one appears.
3. Allow Once for one request, then test Deny on a separate file and check actual file results.
4. Revoke any test grants by returning to Ask.

Reads may run without a card. If no card appears for an operation, check whether the upstream runtime already approved it or whether no tool ran at all. Do not claim a test passed merely because a mode or button was visible.

If the renderer disconnects, backend policy still applies; a request may wait for a decision, but disconnection is not approval. Restore the same chat and inspect pending interactions. An Ask User information card is separate from a permission card.

## Crew approvals and required consent

Michi MCP and sessionApproval are required parts of Crew setup. Missing or revoked consent is incomplete setup and blocks new turns. sessionApproval lets Michi receive and answer Crew's native pending tool requests; consent itself does not automatically approve every tool.

Crew's own allowlists, governance and global YOLO apply first. If Crew already auto-approved an operation, Michi Ask cannot intercept it because there is no pending request. Choose Ask / Trust in Michi for daily use. A global Michi YOLO preference behaves as Trust for Crew.

The upstream sessionApproval grant can also cover user-owned Crew chats. Michi's adapter limits access to its own local unlinked App sessions. Do not control the same session concurrently from Crew and Michi. Read the `crew` guide for the exact one-time authorization steps.

## Agent Runs

Custom Agent definitions select a capability surface and permission ceiling; parent restrictions can reduce it. Ordinary chat Trust does not bypass a Run's effective policy, allowlist or upstream restrictions. Inspect the Run's own interactions and environment. See `custom-agents`.

Related documents: `runtimes`, `runtime-capabilities`, `crew`, `sessions-and-recovery`, `troubleshooting`.
