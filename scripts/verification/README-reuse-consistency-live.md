# Real reuse consistency acceptance

`reuse-consistency-live.mjs` calls the backend's production HTTP routes, the
backend-selected real runtime adapters, and a read-only connection to disposable
SQLite. It never starts a backend/Electron app or provider directly, mocks a
provider, copies credentials, opens a user chat database, or kills processes.

Preparation is read only and makes no provider requests:

```bash
node scripts/verification/reuse-consistency-live.mjs --help
node scripts/verification/reuse-consistency-live.mjs --preflight
node --check scripts/verification/reuse-consistency-live.mjs
```

The coordinator must build the current branch and start the real backend/Electron
against a dedicated folder such as `/tmp/michi-live-TASK`, with separate `data/`
and `config/` children. Supply an unused `PORT`, `MICHI_BIND_HOST=127.0.0.1`,
`MICHI_DATA_DIR=/tmp/michi-live-TASK/data`,
`MICHI_CONFIG_DIR=/tmp/michi-live-TASK/config`,
`MICHI_ENABLED_RUNTIMES=claude,codex,kiro,pi`, and `MICHI_CUSTOM_AGENTS=1`.
Keep `MICHI_CLOUD` unset and `MICHI_SCHEDULED_JOBS` enabled. Do not set
`MICHI_CLAUDE_BARE=1` for native AskUserQuestion coverage. Reuse the machine's
existing authenticated native CLI environment and existing authorized Pi keys;
credential handling is the coordinator's responsibility. Do not print them.
`MICHI_CONFIG_DIR` selects preferences and runtime configuration. The current
credential services intentionally use the machine's existing `~/.michi/config.json`
through `getMichiCredentialConfigPaths`, so a disposable preferences directory
does not create an isolated credential store. The harness writes neither store
and sends no credentials over HTTP. Ordinary ensure-session calls can update
last-used model/provider preferences through the backend in the selected profile.
The script confirms a newly generated graph node is present in the specified
SQLite database before requesting a real runtime session, preventing an accidental
base URL/data directory mismatch from reaching a provider.

`--profiles` accepts a JSON array with public fields only. Obtain valid model IDs
from the existing configuration or the running backend's actual catalog. Agent
bootstrap and Agent Runs require explicit model IDs; ordinary chat can use the
runtime's configured defaults. Example structure (replace model IDs with the
actual selected catalog entries):

```json
[
  {"version":1,"runtimeId":"claude","modelId":"ACTUAL_CLAUDE_MODEL"},
  {"version":1,"runtimeId":"codex","modelId":"ACTUAL_CODEX_MODEL"},
  {"version":1,"runtimeId":"kiro","modelId":"ACTUAL_KIRO_MODEL"},
  {"version":1,"runtimeId":"pi","providerId":"deepseek","modelId":"deepseek-v4-flash","reasoning":"low"}
]
```

Run one runtime or a comma-separated selection. Run the three orchestration cases
only on `--target-runtime`; other selected runtimes get explicit skipped rows.

```bash
node scripts/verification/reuse-consistency-live.mjs --execute --ack-isolated \
  --base http://127.0.0.1:PORT \
  --artifact-temp-folder /tmp/michi-live-TASK \
  --data-dir /tmp/michi-live-TASK/data \
  --config-dir /tmp/michi-live-TASK/config \
  --profiles /tmp/michi-live-TASK/public-profiles.json \
  --runtimes claude,codex,kiro,pi --target-runtime claude \
  --cases stream-io,recovery,cancel,fork,user-input,bootstrap,metadata,run-queued,run-immediate,scheduled-isolation \
  --timeout-ms 180000
```

| Case | Observable evidence |
| --- | --- |
| `stream-io` | Deterministic numbered scratch source copied through real filesystem tools; actual inputJson in SSE and persisted assistant tool calls; relative write/read; exact filesystem contents. |
| `recovery` | Interrupt the HTTP subscriber during a tool turn; reconnect to the same durable turn; increasing replay sequence; session ensure, hydrated message IDs, next-turn memory. |
| `cancel` | Observe a real delayed command's start file, cancel that turn, observe absence of its late write beyond the 25-second deadline, then run a successful next turn. |
| `fork` | Branch from the first answer after a newer parent answer exists; provider recalls the early marker; exact SQLite fork boundary. |
| `user-input` | Two separate real structured requests; pending cards already durable before response; distinct interaction IDs and answered cards on hydration. Pi currently has no ordinary structured input tool and is explicitly skipped. |
| `bootstrap` | Create and enable an Agent definition, bind it with `agentDefinitionId`, verify an unpredictable phrase supplied only in Agent instructions, continue after ensure, inspect persisted binding. |
| `metadata` | Claude/Codex with follow-ups disabled still emit a nonempty overview, no follow-up list/status, and exactly one requested visible answer without repair/acknowledgement leakage. Other runtimes are explicitly skipped for this targeted case. |
| `run-queued` | Real AgentRun shell start, queued supplemental instruction, separate filesystem receipt, durable steering events and attempt/session ownership in HTTP and raw SQLite. |
| `run-immediate` | Real AgentRun shell start, immediate supplemental instruction, separate receipt, interrupted delayed write absent beyond its deadline, ownership in HTTP and raw SQLite. |
| `scheduled-isolation` | One actual scheduled run, a manual run, foreground chat, distinct output nodes and tokens; records overlap or a real capacity 409 followed by serialized admission. |

The optional `source-warning` case is for an environment that actually emits a
Claude organization/runtime warning. It observes a real `claude-cli` runtime
`informational` warning with nonempty text, intentionally cancels its own turn,
and checks the same warning survives SQLite hydration. No warning is synthesized,
and this case does not establish provider response completion. It is excluded
from the default case list. Select it explicitly with `--cases source-warning`.

Metadata acceptance checks the built shared visible-content projection and
persisted assistant content. Raw transport may preserve title/overview sentinels;
concatenating wire chunks alone does not establish visible UI leakage.

The ordinary recovery case proves reconnect/hydration. Actual backend process
restart uses two explicit phases; only the coordinator can attest that the PID
changed:

1. Run `--cases restart-seed` with the selected runtimes and retain its printed
   `manifest.json` path. Every phase still requires the same base/path flags.
2. Coordinator stops and restarts only its own backend process with identical
   isolated data/config and port. Save old/new PID evidence separately.
3. Run `--cases restart-verify --resume-manifest /absolute/path/manifest.json`.

Each invocation creates a named evidence subfolder beneath the artifact temporary
folder, containing `manifest.json`, `summary.json`, raw timestamped SSE JSONL,
production HTTP hydration, scoped SQLite snapshots, and cleanup results. Provider
latency controls duration: normally 5–10 minutes per runtime for the six main cases,
plus 3–6 minutes for the target's orchestration cases. Each stream/poll defaults to
180 seconds. Failures retain evidence, cancel only this manifest's handles, and
continue to the next case; any failed row in the current invocation produces a
nonzero exit status. Resuming a manifest retains earlier failed rows and reports
them separately from the current invocation, so a later successful restart verify
or cleanup has an accurate exit status without erasing history. Evidence
and test workspaces remain available for Electron inspection. No Electron UI
claim is made by this HTTP harness.

SIGINT/SIGTERM and normal exit cancel recorded chats/runs, cancel and remove the
created jobs, and disable created definitions. Workspaces and files are preserved.
To repeat cleanup after an interrupted script, pass `--cleanup-only --ack-isolated
--resume-manifest /absolute/path/manifest.json` and the same base/path flags. There
is no `pkill`, process search, user-workspace deletion, or application shutdown.

Crew is reported separately through offline integration fields and the production
`GET /api/crew/status` route. Installed/configured status does not establish a live
Gateway connection or Crew runtime behavior. When the coordinator explicitly
authorizes a real test using already complete existing setup, run
`--runtimes crew --cases exact-reply --allow-existing-crew`. The harness checks
enabled/current App, existing approval consent, declared/routed MCP and backend
availability before session creation. It never changes setup, consent, accounts,
routes or global Crew settings, and stops when any gate is missing. This optional
case creates one isolated chat using Ask and learned Memory Off, sends a no-tool
single-word request, then checks real SSE, runtime identity and durable content.
It is not ordinary Kiro coverage and does not establish Crew tools/MCP/approval,
resume, fork or steering behavior. All default runtime selections still exclude Crew.
