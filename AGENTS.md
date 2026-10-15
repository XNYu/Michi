# AGENTS.md

Project-specific guidance for Michi. Use current source and package scripts to
resolve discrepancies. README.md documents architecture and setup; read relevant
sections when needed, not the whole document before every edit.
Keep this file in version control so new checkouts and worktrees receive the same
project guidance. Keep personal preferences and machine-specific notes separate.

## Commands

Install with `npm install` from the root. The npm workspaces are `frontend/`,
`backend/`, and `shared/`, plus the Electron wrapper in `electron/`.
The backend requires Node.js 22+ for built-in SQLite.

- `npm run dev`: builds shared code, then starts the backend esbuild watcher
  and Vite frontend. Default ports are backend 3000 and frontend 3001.
- `npm run backend:dev` / `npm run frontend:dev`: starts one side after building
  shared code. Backend development defaults MICHI_DATA_DIR to ~/.michi-dev;
  use an isolated directory for disposable data.
- `npm run build`: builds frontend with Vite, then backend with TypeScript
  checking and esbuild. Workspace build scripts build shared code first.
- `npm run build:artifact`: runs build, then copies frontend/build into
  backend/dist/frontend for artifact collection. Plain build does not copy it.
- `npm start`: runs the bundled backend with --experimental-sqlite. It also
  serves frontend/build when present.
- `npm run typecheck -w frontend`: checks frontend TypeScript including tests;
  Vite build does not perform this check. `npm run lint -w frontend` runs ESLint.
- `npm test -w frontend`: runs the full isolated Vitest suite (Node logic tests
  plus jsdom component/browser tests). Shared imports resolve to source, so
  frontend test/watch commands do not need `shared:build`; builds, typechecks,
  backend tests and E2E still do.
  Filter with `npm test -w frontend -- src/state/chatStreamRunner.test.ts`.
- `npm test -w backend`: builds shared code and runs node --test through
  ts-node on backend/test/*.test.ts, with a per-test timeout.
- `npm run test:e2e`: builds shared code and runs Playwright against the web UI.
  The mock API fixture intercepts backend requests; this suite does not require
  a real backend, SQLite, credentials or an agent CLI. Preserve that isolation.
  Use `npm run test:e2e -- e2e/specs/chat-stream.spec.ts` for a focused spec,
  or `npm run test:e2e:ui` for UI mode. Set E2E_PORT to an unused port to
  isolate a checkout; this disables reuse of an existing server.

predev and preelectron:dev run scripts/kill-stale-dev.mjs. Development launchers
and packaging are not side-effect-free test commands.

## Testing workflow

Run commands from the repository root. Paths after `-w frontend --` are relative
to `frontend/`, not the repository root. `npm exec -w backend` runs in `backend/`.

Choose validation by the behavior and dependencies affected:

- Documentation-only changes: review commands, links and the diff; no builds or
  runtime tests. For small copy/style changes, run relevant existing tests or a
  focused visual check. Add tests when they protect meaningful behavior.
- Local frontend/backend changes: run the affected test files and nearby behavior
  tests. For TypeScript changes, run the affected workspace's typecheck.
- Streaming, queues, cancellation, hydration or persistence changes: cover the
  affected transitions and failure paths; add the relevant isolated E2E spec when
  browser interaction is involved. Trace protocol changes across both workspaces.
- Broad refactors, shared infrastructure or dependency/test configuration changes,
  release preparation, or unresolved cross-module risks: run the affected full
  suites. A shared module's consumers determine the scope; a small diff alone does
  not establish low risk.
- Merging an already validated branch: inspect the merge result and test conflict
  resolutions and interactions with newer changes. Repeat passed checks only when
  the resulting code, environment or evidence gives a reason to do so. A routine
  local merge does not require another full suite.

```bash
# During edits: choose a focused file, changed tests, or a warm watch loop.
npm test -w frontend -- src/state/chatStreamRunner.test.ts
npm run test:changed -w frontend
npm run test:related -w frontend -- src/components/ui/DrawerShell.tsx
npm run test:watch -w frontend -- src/state/chatStreamRunner.test.ts

# Select an environment when appropriate.
npm run test:node -w frontend
npm run test:dom -w frontend

# Typecheck the affected workspace after TypeScript changes.
npm run typecheck -w frontend

# Backend typecheck/tests consume built shared code; select explicit test files.
npm run shared:build
npm exec -w backend -- tsc --noEmit
npm exec -w backend -- node --require ts-node/register --test \
  --test-timeout=30000 --test-concurrency=1 test/kiroCancelResume.integration.test.ts

# Full suites when the scope above warrants them.
npm test -w frontend
npm test -w backend
```

- `test:changed` includes staged, unstaged and untracked changes. Common modules
  may select most tests. For committed branch changes, use an appropriate comparison
  ref (for example `npm run test:changed -w frontend -- --changed=dev` on a feature
  branch) or explicit test files. Check what was selected; zero tests is not
  validation. Dependency selection can miss indirect/runtime relationships.
- Keep file isolation enabled. Frontend Vitest has a worker cap of four; use
  `npm test -w frontend -- --maxWorkers=2` to reduce load. Backend Node tests use
  `--test-concurrency`, not Vitest's `--maxWorkers`. For focused browser checks on
  a busy machine, use an unused E2E_PORT and Playwright `--workers=1`.
- Avoid concurrent full suites across checkouts on the same machine. On resource
  exhaustion, hangs or timeouts, inspect the failing test/worker before rerunning;
  stop only processes started for the current task. Lower concurrency or rerun
  the affected file when appropriate, rather than launching another full suite.
- Do not pipe test output through `tail`: it hides progress and can mask failure.
  Report which checks passed, failed or were incomplete. A successful focused
  rerun does not make an earlier failed full run a full-suite pass.
- `frontend/vitest.config.mts` owns Node globs and DOM exceptions. Some `.ts`
  files render hooks or use window-backed storage; keep those in the DOM project.
- Use stable array/Set/Map props in hook tests and fake timers for long waits.
  The DOM setup fails fast on React effect loops; fix the loop, not the guard.

## Backend and streaming

- backend/src/server.ts opens databases, configures auth/CORS and routes, and
  registers enabled factories from backend/src/agents/runtimeFactories.ts.
  Do not assume CORS is globally open.
- Runtime adapters live in backend/src/agents/: Kiro uses kiro-cli over ACP,
  Pi uses provider APIs in-process, Claude uses the Claude CLI, and Codex uses
  app-server JSON-RPC. Crew reuses KiroRuntime with a bundled ACP adapter connected
  to the official Kiro Crew Gateway; its factory pins the v2 engine independently
  of MICHI_KIRO_ENGINE. Preserve Crew's own capabilities and approval/setup
  requirements; see agents/crew/README.md and runtimeFactories.ts. CLI requirements
  depend on the selected runtime.
- backend/src/agents/chatHub.ts owns durable turns and subscriber replay;
  sessionRegistry.ts tracks live sessions. services/chatManager.ts is a
  compatibility facade and binding helper, not the owner of a global ACP pool.
  Kiro pooling lives under agents/kiro/ and services/acpClient.ts.
- shared/src/ owns shared protocol types and turn projection. Transport uses
  SSE payloads via fetchStream/ReadableStream, multiplexed over one WebSocket per
  gateway/window after capability negotiation. Old gateways fall back to HTTP
  SSE. Keep persistent feeds off native fetch/EventSource on upgraded gateways.
  backend/src/services/streamTransport.ts reuses guarded HTTP routes; preserve
  its one-use tickets, route allowlist, cancellation and resource bounds.
  `npm run test:stream-transport` tests concurrent streams alongside ordinary
  requests in isolated Chromium without SQLite, real agents or user data.
- For event changes, trace the affected runtime adapter, normalized types in
  backend/src/services/chatEvents.ts, backend/src/routes/chatStreamEvents.ts,
  shared/frontend event schemas, frontend/src/services/api/stream.ts and api.ts,
  frontend/src/state/chatStreamRunner.ts, and relevant reducers/projection.
  Update affected tests and SSE mocks. Do not assume chatStore handles every hop.
- Explicit cancellation and renderer disconnection are different. A disconnected
  renderer can leave a durable turn running for reconnection. Use res.on("close"),
  not req.on("close"), for SSE subscriber cleanup; do not cancel every disconnected
  turn. Intentional cancellation is not a user-facing error.
- Visible response completion, durable turn completion and runtime cleanup are
  separate boundaries. A completed visible answer can leave runtime ownership
  active; preserve both chatHub.isActive() and isOwnerTurnActive() guards.
  Only a confirmed HTTP 409 with code `turn_active` permits silent retry of the
  same serialized request and turn ID. Keep normal cleanup invisible; do not show
  receipt/withdrawal/wait notices or ask the user to retry or create a branch.
  Do not resend a message after ambiguous network failures or other conflicts;
  reconnecting to an existing durable turn is a separate recovery path.
  Cancelling a send rejected as busy must not cancel the previous turn. Late
  events from an older turn must not consume a newer turn's queue, invalidate its
  session binding or overwrite its foreground state.
- Preserve turn/assistant IDs and sequence watermarks across live streams,
  replay and hydration.
- Kiro MCP HTTP entries require headers: [] even when empty; see
  backend/src/agents/kiro/KiroRuntime.ts. Preserve ACP queue draining and
  previous in-flight prompt handling so cancelled chunks cannot leak into
  the next prompt.

## Persistence and frontend

- SQLite data.db is the durable source of truth for workspaces, messages, turns,
  runtime bindings, artifacts and related state. See backend/src/services/dbRepository.ts
  and backend/src/db/migrations/.
- frontend/src/state/workspacePersistence.ts handles backend hydration and
  persistence; chatHydration.ts maps stored data. Preserve the hydration barrier:
  an unavailable backend is not an empty workspace that may overwrite saved data.
- LocalStorage supports legacy migration/cache/fallback and small scoped UI state,
  not authoritative chat storage. Successful backend hydration clears the durable
  localStorage mirror. Do not restore unconditional whole-state localStorage writes
  or assume all runtime sessions are lost on reload.
- Recovery uses persisted runtime bindings where supported and history-based
  reconstruction otherwise. Preserve owner/workspace isolation in persistence,
  resume, search, export and runtime lookups.
- The live UI is a page-routed terminal shell, not the removed React Flow canvas.
  frontend/src/components/terminal/TerminalShell.tsx owns shell routing and
  keyboard handling; pages/Dashboard.tsx displays resizable panes. pages/Map.tsx
  is graph navigation, not a replacement editor. Preserve the pane-oriented workflow.
- TPane.tsx composes chat rendering and the composer. The shared TipTap composer
  is components/terminal/manage/ManageComposer.tsx under frontend/src/.
- frontend/src/state/chatStore.tsx coordinates domain reducers and helpers.
  nodesRef updates synchronously with dispatch so node creation followed immediately
  by sending works before the next React render; do not move this into an effect.
- A workspace is a forest. Use activeTreeRootNodeId(project) and findTreeIdForNode,
  not project.chatIds[0], for tree ownership. Preserve archive read-only behavior
  and cross-tree validation. Tree traversal must not cascade deletion across
  merge/link or digest-source relationships.
- frontend/src/state/paneState.ts keys pane state by workspace and tree, with an
  explicit workspace slot. Open/focused pane maps and pane items use sessionStorage.
  Do not collapse keys to workspace-only or describe this state as never persisted.
  Background stream events must not steal focus or switch the active tree.
- Reusable material uses artifacts and mention resolution. Consult
  frontend/src/state/contextBudget.ts and artifact paths rather than restoring
  the historical Project.contexts/save_context model or obsolete budget constants.
- Use theme tokens from frontend/src/index.css and Tailwind's @theme mapping
  (bg-app, bg-surface, text-fg, border-line, etc.), not hardcoded surface/text hex
  colors. Workspace badge palette colors are an intentional decorative exception.

## Electron and production

- `npm run electron:dev` uses scripts/electron-dev.mjs to build shared code,
  start backend/Vite and launch Electron. It selects an available renderer port
  unless MICHI_RENDERER_PORT is set and passes MICHI_RENDERER_URL to the shell.
- `npm run electron:build` builds frontend/backend/main, rebuilds native modules,
  and invokes electron-builder. On macOS the default is an unsigned arm64 DMG
  in dist-electron/; Windows defaults to x64.
  **On macOS its npm postbuild hook quits Michi and replaces ~/Applications/michi.app.**
  Do not use it as routine verification unless installation/replacement is requested.
- scripts/electron-build.mjs sets VITE_API_URL=/api. Production normally forks
  the bundled backend, waits for health, and loads its HTTP-served UI.
  electron/main.ts retains a file:// fallback when no backend port exists;
  that is not the normal production topology.
- frontend/vite.config.mts sets base: './' and outDir: 'build'. Frontend env vars
  use VITE_*, not CRA's REACT_APP_*. frontend/tsconfig.json includes tests and
  Vitest globals; there is no Jest/Babel or react-scripts build path to restore.
- electron/preload.ts exposes folder/file, notification and other native operations.
  Feature-detect via frontend/src/lib/electronBridge.ts; it is absent in browsers.
- Root package.json owns packaging. Frontend assets, bundled backend and compiled
  Electron main/preload ship together. Do not mirror bundled backend dependencies
  into root dependencies as a packaging whitelist. Native Electron modules such
  as node-pty require the existing rebuild/unpack setup.
- Preserve Electron's NODE_OPTIONS handling; flags accepted by Node in a shell
  may be rejected by Electron.

## Docs

README.md describes current architecture, runtime setup, persistence and packaging.
The removed canvas is on archive/canvas-view-2026-04-29, not in the live frontend.
Read historical documents only when relevant to the task.
