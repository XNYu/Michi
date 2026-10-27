# Use KiroCrew in Michi

Updated October 13, 2026 for Michi Crew App **0.6.0** and official KiroCrew **0.9.0-insider.6**. Terminal examples use macOS/Linux syntax.

KiroCrew supplies the backend. After one-time setup, use **Michi** for chats, approvals, model selection, Memory, resume and forks. Keep KiroCrew running. **Michi MCP and sessionApproval are required and included in the App.**

## 1. Update your Michi installation

The public installer clones Michi into **~/Michi**. For that checkout, first follow section 9 to prepare a Crew App with an explicit installation path and keep its generated files in a persistent App source; then complete authorization in section 3. The **~/.michi** data directory alone is not a source installation.

The direct **~/.michi/crew-app** instructions below apply only when your source checkout and build actually live at **~/.michi**. On macOS the desktop application is installed in **~/Applications/michi.app**. Crew stores its configuration and Apps in **~/.kiro/crew** by default.

Use a Michi release containing Crew App **0.6.0 or newer**. Update through the normal command:

```sh
michi update
```

On macOS the update rebuilds/replaces the application and quits Michi; reopen it afterward. A local development commit becomes available to other installer users only after it is published to the installer's source branch.

A default installation already contains the complete **~/.michi/crew-app** directory. **Do not run crew-setup.cjs or copy App files for a new default installation.** A data directory from a standalone desktop bundle alone is not an installation checkout: it must contain `crew-app/launch.py`, `backend/dist/crewMcpHost.js`, `backend/dist/crewMcp.js` and `backend/dist/crew-node.json`.

## 2. Install the App directly in Crew

Start the official KiroCrew application and sign in. The default local Gateway is `http://127.0.0.1:5476`.

In Crew, open **Apps / Discover → Manage app sources → Install from path**. Enter the **absolute path** to your installation's `crew-app` directory:

| Platform | Example path; replace the username |
| --- | --- |
| macOS | `/Users/yourname/.michi/crew-app` |
| Linux | `/home/yourname/.michi/crew-app` |
| Windows | `C:\Users\yourname\.michi\crew-app` |

Do not enter a literal `$HOME`, `${HOME}` or `~` unless Crew's path field explicitly expands it. If needed, print your macOS/Linux path with `printf '%s\n' "$HOME/.michi/crew-app"`.

Crew records this directory as the App's source. Keep the installation at that location. The App is named **michi-crew-runtime** and includes the **michi-crew** agent template, Michi MCP and approvals.

For a custom installation, custom MCP binding directory, source worktree, or an App previously installed from a generated directory, use the compatibility instructions in section 9. Do not install a second App with the same name or uninstall the existing one to update it.

## 3. Complete one-time authorization and keep the App updated

### Grant sessionApproval

Review the **sessionApproval** disclosure, consent, and confirm the App is **Enabled**. This allows Michi to receive and answer Crew's native pending tool requests. It does not automatically approve every tool; choose **Ask / Trust in Michi**.

The official grant also covers user-owned Crew chats. Michi's adapter restricts its access to its own local, unlinked App sessions. Avoid controlling the same session concurrently from Crew and Michi.

### Enable Michi MCP through the official broker

1. Open **Developer → MCP Management** in Crew. If Developer is hidden, enable **Settings → Developer → Developer Mode** first.
2. Find **michi-crew-runtime:michi**.
3. Enable **Stub / Routed**, inspect the launch and approve it. After Sync, reload this page: **command changed** means the new Python launch still needs approval. A saved Stub opt-in alone does not prove the new command is approved.
4. The manifest names `python`. Crew resolves this to its own Python interpreter. The launcher starts Michi's MCP host using a supported Node recorded by the Michi build; it does not depend on the GUI's Node PATH. Node must be **22.19 or newer**. The default installation is resolved inside the launcher as `~/.michi`; Crew does not need to substitute placeholders in command arguments.
5. After first installation, or migration from an App older than **0.6.0**, restart the **Gateway** so the new template, broker route and Python host launch replace cached entries. Finish or stop active Crew work first. Use `kirocrew restart` for the default service-managed Gateway. **Apply & Restart** in Agent Capabilities only restarts chat agents. This one-time restart is required even if Sync does not display a restart prompt.

After this setup, all daily chats and approvals take place in Michi.

### Later updates: Michi update, then Crew Sync

```sh
michi update
```

Then open **Apps / Library → Michi Crew Runtime → Sync** in Crew. Sync rereads the recorded `~/.michi/crew-app` source, updates its manifest/template, and preserves the App secret and App data. No App generation or copying is needed for default installations. After Sync, reload **Developer → MCP Management** and approve the new command if it reports **command changed**. The first migration from an App older than **0.6.0** also requires a Gateway restart; later host/launcher/API changes may require another restart, as described by the release.

Michi checks the installed App version and displays **Sync Crew App** when it is older than the version included in Michi. It blocks new Crew work until the App is updated; return to Michi after Sync to refresh the check.

Already-running MCP connections load updated compatible relay handlers on subsequent requests. In-flight calls finish with the generation they started with. A rebuild gap retains the last working handlers. A change to the host/launcher or handler API still requires a new MCP process; reopen the Crew session or restart its Gateway when the release requests it.

## 4. Open Michi and create a Crew chat

On macOS, launch Michi normally, or run:

```sh
michi
```

For a source installation, run `npm start` from the built checkout and open the address it prints; the default is `http://localhost:3000`.

In Michi:

1. Open **Settings → Model** and select **Kiro Crew**, or select it in a new chat's composer Runtime menu.
2. Choose a model and reasoning level.
3. Create a new chat and send a message.

Keep the default **michi-crew** template for the complete Michi integration. Existing sessions retain their template identity when resumed.

The composer can select other Crew templates, but those templates may lack Michi instructions or MCP access. A custom template must retain the Michi prompt/output conventions and the `@michi-crew-runtime:michi` tool reference with its MCP configuration. After changing templates, verify `michi_list_tools` again.

The **michi-crew** template contains the fixed Michi instructions. Messages carry dynamic context and a short output-format reminder. For short tasks, Medium / High reasoning may be more responsive than Extra high / Max; model latency, Memory retrieval, and queued work also affect response time.

## 5. Choose a Memory mode

When the runtime selected in **Settings → Model** is **Kiro Crew**, a **Memory** selector appears above **FOLLOW-UPS**. It sets the default for **new Crew chats**.

| Mode | Behavior |
| --- | --- |
| Read & learn | Recall saved memory and allow learning reusable preferences. |
| Read only | Recall saved memory without adding or changing it. |
| Off | Disable long-term memory reads and writes. |

An established chat keeps its Memory mode. A fork inherits that mode. To use a different mode, change the default and create a new chat.

Memory is separate from chat history. **Off** does not delete messages; Michi still saves the conversation. The Crew template, governance policy, and bound identity can further restrict Memory tools.

## 6. Choose how tools are approved

Set the mode in **Michi Settings → Model → Permissions**:

- **Use global permissions on:** one setting applies across chats; the composer hides its permission switch.
- **Use global permissions off:** choose **Ask / Trust** in each chat's composer.
- **Ask:** pending native tool requests appear as approval cards in Michi.
- **Trust:** Michi answers pending requests automatically according to its permission policy.

There is one approval workflow, in Michi. If sessionApproval consent is missing or revoked, setup is incomplete: new turns are blocked until access is restored.

Crew has no separate Michi YOLO control. A global Michi YOLO preference behaves as Trust for Crew. Crew's own allowlists, governance rules, and global YOLO apply first. If Crew auto-approves an operation, there is no pending request for Michi Ask to intercept.

| Approval button | Scope |
| --- | --- |
| Deny | Reject this request without saving a grant. |
| Allow Once | Approve only this request. |
| Trust this tool | Save a grant for this tool in the current Michi chat; it can survive resume. Disabled when the runtime cannot identify the tool reliably. |
| Trust all tools for this session | Trust tools in the current runtime session. This is temporary, is not saved to the database, and expires when the session is recreated or permission settings are explicitly changed. |

To revoke trust, select **Ask** again. With global permissions enabled, this clears the user's chat tool grants; with per-chat permissions, it clears only that chat's grants. Forks do not inherit these grants.

Buttons are neutral gray until hover/focus. There are no dedicated approval shortcuts; use a click or Tab followed by Enter / Space.

## 7. Check that setup works

1. Send a short message in a new Crew chat. Confirm that you receive a reply and a title.
2. Change Memory to Off, then create a new chat to test that default.
3. Ask: **“Call michi_list_tools and list the Michi tools available to this chat.”** Confirm a tool result; an installed manifest alone does not prove that routing works.
4. Select Ask and request a small tool operation in a disposable test directory. Low-risk reads may be auto-approved by Crew. When a card appears, test Allow Once, then Deny on a separate request.
5. Finish a turn, reopen the chat, and try a historical fork to check resume and branching.

## 8. Troubleshooting

| Symptom | What to check |
| --- | --- |
| Crew runtime or setup files are missing | The installed Michi version must include Crew support. Update the installed application; a local development merge alone is insufficient. |
| Crew setup required | Install or Sync the complete App, complete sessionApproval consent, and enable/approve Stub / Routed. Restart the Gateway if Crew requests it. |
| Crew is unavailable or a chat cannot start | Run the official Gateway, confirm the App is Enabled, and check the Node executable and ACP build. Custom Gateway URLs must remain loopback addresses. |
| MCP reports missing caller identity | Reload Developer → MCP Management after Sync and resolve command changed by approving the current launch. Confirm Stub / Routed, restart the Gateway, then send a new turn from Michi. A saved Stub opt-in can coexist with an unapproved launch; direct stdio cannot replace the broker route. |
| MCP uses an old worktree | Check MICHI_CREW_INSTALL_DIR for a custom installation and refresh the registered source described in section 9. |
| Ask does not show a card | Check sessionApproval consent, App enablement, global/per-chat permissions, and Crew's allowlist/global YOLO. |
| Changing Memory does not affect an existing chat | The mode is fixed after creation. Change the default, then start a new chat. |
| Responses are slow | Check reasoning level, queued work, and pending approvals. Try a short message with Medium / High reasoning. |

After changing process-level configuration, restart Michi. Defaults include `CREW_GATEWAY_URL=http://127.0.0.1:5476`, `KIROCREW_HOME=~/.kiro/crew`, and `MICHI_CREW_MCP_DIR=~/.michi/crew-mcp`. Michi and the MCP relay must use the same binding directory. The packaged macOS app reads overrides from `~/.michi/.env`; the setup helper does not load that file. If you customize `MICHI_CREW_MCP_DIR`, pass the same absolute path when preparing the App, for example:

```sh
MICHI_CREW_MCP_DIR="$HOME/custom-crew-mcp" node backend/scripts/crew-setup.cjs
```

Use your actual directory in both places. Defaults need no override.

## 9. Existing generated sources and custom installations

Existing users keep their registered App source and credentials. Their source does not automatically move to the new default directory. A custom Michi installation also needs an explicit installation path in the App environment.

From your actual Michi installation or built source checkout, run:

```sh
node backend/scripts/crew-setup.cjs
```

The helper prints **Prepared App: /actual/path/michi-crew-app-...** and always includes both capabilities. It sets `MICHI_CREW_INSTALL_DIR` to that checkout and `MICHI_CREW_MCP_DIR` to the binding directory. It prepares files without granting authorization.

For a first custom installation, copy the prepared files into a dedicated persistent App source, such as `<custom-install>/crew-app-prepared`, then install from that absolute path. **Do not copy generated files over the repository's canonical crew-app directory.**

For an existing App, read its registered source without reading credentials:

```sh
node -p 'require(require("node:path").join(process.env.KIROCREW_HOME || require("node:os").homedir() + "/.kiro/crew", "apps/michi-crew-runtime/installed.json")).source'
```

If Crew uses a custom home, export the same `KIROCREW_HOME` first. Copy the prepared files into the **exact dedicated generated source** recorded there, then click **Sync**. A missing old temporary source can be recreated at that same path. Preserve the App; do not uninstall. Crew's current UI does not offer a change-source control.

Example, after replacing both placeholders with the actual paths:

```sh
PREPARED_APP="/actual/path/michi-crew-app-..."
CREW_APP_SOURCE="/exact/registered/generated/source"
mkdir -p "$CREW_APP_SOURCE"
cp -R "$PREPARED_APP/." "$CREW_APP_SOURCE/"
```

If the registered source points into a code checkout, do not overwrite it with generated files. Source migration uses Crew's authenticated update API with an explicit source; arrange that migration while preserving the existing secret and sessions.

## Current limits and verification scope

Text/thinking, native tool results, model/reasoning/template selection, resume, historical forks, Crew Memory, Michi MCP and approvals in Michi are implemented. Official App callers cannot use **same-turn steer**; busy messages queue for the next turn. Crew compacts automatically, but Michi has no manual Crew compact command or dedicated Crew subagent manager. The adapter does not support image/audio attachments. Private Member Memory inheritance remains unverified.

On October 13, 2026, the production manifest passed official **0.9.0-insider.6** parser/install/Sync checks in an isolated home. The actual installed App was updated through Crew's **Sync** UI. Real model calls verified concurrent MCP isolation, adapter restart/resume, independent fork bindings and refusal for unbound sessions. Default-path startup with spaces and an empty Node PATH, plus same-connection handler updates and rebuild recovery, passed real stdio transport tests. The official broker also loaded a new relay generation during the same real model turn while retaining its host process, then recovered the original generation. Native approval allow/reject/cancel and a clean successor turn passed against an isolated official Gateway. In the actual Michi browser UI, Allow Once wrote the expected test file and Deny prevented a separate file from being created. An isolated old App version displayed Sync Crew App, and returning to 0.6.0 restored Ask. Trust button semantics have automated coverage; these two Trust choices were not manually exercised against a real model in this acceptance run.

The exact default `~/.michi` path was tested in an isolated HOME with the official Python and real stdio transport. This machine's installed App uses the custom-worktree compatibility environment, so the real Crew routing tests use that environment. These are macOS checks; Windows/Linux launcher compatibility is designed but has not received live acceptance on those platforms. The macOS installer/update packaging itself was inspected, not run during acceptance, because it replaces the user's desktop app. The source/build integration and all required artifacts were verified separately.
