# Antigravity runtime (`agy acp`)

This optional runtime-package preset runs Google's Antigravity CLI through its stdio ACP server, `agy acp`
(ACP protocol v1), as a preset of the Kiro runtime: id `antigravity`, label
**Antigravity**, engine pinned to v2 (one `agy acp` process per cwd, chats
multiplexed on it). agy speaks standard ACP only, so the launch sets
`standardAcp` and no Kiro extension is ever sent.

## Host integration

The public Michi backend currently registers its existing Antigravity adapter
in `backend/src/agents/antigravity/`. This package preset is available for hosts
that explicitly integrate `createAntigravityRuntime`; it does not replace that
backend registration.

Pass the executable path and search path through `AntigravityAdapterOptions`
when creating the preset. The adapter does not read host environment settings.

agy keeps its own sign-in. Run `agy` once in a terminal and sign in with
Google; while it is signed out, a new chat fails with a sign-in message.

## Capabilities

| Capability | In Michi |
|---|---|
| Streaming text and thinking | Yes |
| Tool cards (edit diffs, shell output, reads, MCP calls) | Yes; Michi's tools (`mcp_michi_<tool>` in agy) show under their own names |
| Approvals | Ask and Trust through `session/request_permission`, for edits and commands |
| Stop | Yes; the prompt settles as cancelled |
| Native resume | `session/load` after a `session/list` check; a lost session is rebuilt from Michi's history |
| Fork | History replay (agy has no `session/fork`) |
| Models | The session's `model` config option |
| Reasoning | The session's `thought_level` config option: low, medium, high |
| Titles | agy's own `session_info_update` |
| Usage | Token counts from the `session/prompt` result; no cost and no context % |
| Michi tools (ask_user, follow-ups, branches, artifacts, …) | Yes, over HTTP MCP |
| System prompt | Michi's stable instructions in `_meta.antigravity.systemPrompt.append` on session/new; kept across session/load |
| Images | Sent as file links (`resource_link`) that agy reads itself |
| Steer, compaction, plan modes, subagent roster | No |
| Warm sessions, Agent Runs, Meta agent, restricted sessions | No |

## Limits

- No steer: a message sent while agy is busy waits for the next turn.
- No compaction command: `/compact` answers that it is not supported. agy
  compacts on its own.
- No plan or accept-edits modes: ACP has no route to them.
- YOLO behaves as Trust: Michi answers every approval request. agy itself
  never asks before reads inside the workspace or MCP tool calls.
- A subagent agy starts finishes as a tool call; its report arrives at the
  start of the next turn.
- Images are sent as links to their files, because agy drops ACP image blocks.
- Model and reasoning are not kept by agy across session/load; Michi applies
  them again after a resume.
