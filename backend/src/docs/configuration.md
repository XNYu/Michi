# Configure Michi, credentials and updates

Applies to: installed desktop/web, source checkouts and remote backends. Shell examples use macOS/Linux syntax unless stated otherwise. Source checked: 2026-10-16. Configuration is backend-specific; some credential/Electron paths do not honor every directory override.

## Know which installation you are configuring

| Location | Default purpose |
| --- | --- |
| `~/Michi` | Public source installer checkout |
| `~/.michi` | Default production state/config root |
| `~/Applications/michi.app` | Installed macOS desktop application |
| Your project directory | Workspace files; independent of installation |
| `~/.michi-dev` | Default data directory for root development launchers |
| Remote server paths | Runtime processes, workspace files and state belonging to that remote backend |

Custom installations and data directories may differ. Do not substitute a developer's absolute checkout path into end-user instructions. A standalone desktop bundle's state folder is not necessarily a built installation checkout.

## Configuration sources and precedence

| Source | Used for | Precedence/limitations |
| --- | --- | --- |
| Backend process environment | Runtime launch, deployment and overrides | Takes precedence over `backend/.env` |
| `backend/.env` | Backend environment for repository runs | Does not override existing process values |
| `~/.michi/.env` | Packaged Electron startup environment | Loaded before the backend starts; existing process values win |
| `<installation>/.env` | `michi` launcher configuration, including web `PORT` | Sourced by that launcher; not a universal configuration loader |
| `config.json` under `MICHI_CONFIG_DIR` | Runtime/model/UI preferences in supporting modules | Default `~/.michi`; provider credentials and Electron settings still use `~/.michi/config.json` |
| Frontend `.env.local` / Vite mode files | Renderer build-time `VITE_*` values | Not a live backend runtime-setting mechanism |

Restart the owning process after changing startup environment. A helper command does not necessarily load the desktop `.env`; Crew custom preparation requires its environment to be passed explicitly as described in `crew`.

## Which settings affect an existing chat?

| Setting | Scope and timing |
| --- | --- |
| Default Runtime in Settings → Model | New chats; existing chats keep their runtime |
| Provider/model/reasoning | Depends on runtime and the current chat's controls; verify the next response's effective choice |
| Global permissions | Ordinary chats on that backend, scoped by owner when hosted; applies from the next turn |
| Per-chat permissions | Used when global control is off; individual choices are preserved while global control is on |
| Native Resume | Per runtime; changes future cold restoration, not already-live sessions |
| Native Fork | Per runtime; changes future child creation, independently of Native Resume |
| Crew Memory default | New Crew chats; existing chats keep their mode, forks inherit it |
| Custom Agents feature flag | Startup-only experimental gate; requires backend restart |

A disabled or absent control may mean the current runtime does not expose that capability. Changing a default does not migrate all existing sessions.

## CLI works in Terminal but not in Michi

1. Confirm the CLI is on the backend machine. Installing it on the desktop does not install it on a remote server.
2. In a terminal on that machine, locate the executable and check its version. macOS/Linux examples: `command -v kiro-cli`, `command -v claude`, `command -v codex`. On Windows use `where kiro-cli`, `where claude` or `where codex`.
3. Desktop applications do not necessarily inherit interactive shell startup files or version-manager PATH. Configure an absolute executable override when needed.
4. Authenticate/configure that runtime using its supported local mechanism under the same user/home the backend runs as.
5. Restart Michi after environment changes and test a small request.

Supported launch variables include `KIRO_CLI_BIN`, `CLAUDE_CLI_BIN`, `CODEX_CLI_BIN` and optionally `CODEX_HOME`. Do not paste credentials into a prompt or into a shared diagnostic transcript. See `runtimes` for provider details.

## Pi provider credentials

Configure the provider in Settings → Model. API-key providers need the selected provider's credentials. Amazon Bedrock supports an AWS Profile, Bearer Token, Access Keys or the SDK default credential chain, plus region and optional credential refresh command.

Existing AWS environment variables take precedence over saved Bedrock configuration. If Michi uses an unexpected account/region, inspect which credential source is active without printing secrets. Credential presence is not proof of valid access to a chosen model.

Local credentials are stored in `~/.michi/config.json`; hosted per-user keys use a separate encrypted vault. Use `privacy-and-data` for storage boundaries.

## Update an installed checkout

Preserve local source edits, pull the public `main` branch, run `npm install`, and rebuild the relevant target from the installation checkout. Follow the repository README for the platform you use. A local development commit is available to others only after publication.

On macOS, `npm run electron:build` quits/replaces the app. For a remote service, follow `remote-backend` to rebuild and restart it. Forced resets and deleting application state are not routine update steps.

Crew users must also Sync their existing App and approve the current Stub / Routed launch when it changes, following the `crew` guide. Do not uninstall the App or create a second one as an update shortcut.

## Directory and deployment overrides

`MICHI_DATA_DIR`, `MICHI_CONFIG_DIR` and `MICHI_LOG_DIR` choose state/config/log locations in supporting modules. `MICHI_ENABLED_RUNTIMES` restricts registered runtimes. Node.js 22.19+ is the source/remote baseline. The backend's default repository port and installed web launcher's port differ; use the actual printed address.

Development launchers, updates and Electron packaging can stop processes or replace the app. They are not read-only diagnostic commands. For remote deployment use `remote-backend` rather than a local desktop launch recipe.

Success check: the intended backend reports the expected runtime/model, a small request works, and the chosen settings survive reopening the relevant UI. If not, retain the error and inspect that backend's effective configuration source.

Related documents: `runtimes`, `permissions`, `crew`, `remote-backend`, `troubleshooting`.
