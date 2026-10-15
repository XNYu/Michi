# Use KiroCrew in Michi

Updated October 13, 2026. This guide is for an installed Michi application and the official local KiroCrew Gateway. Terminal commands below use macOS/Linux shell syntax.

KiroCrew supplies the backend. After the one-time setup below, use **Michi** for chats, tool approvals, model selection, Memory settings, resume, and forks. Keep KiroCrew running. **Michi MCP and Approvals are required parts of this integration and are included by default.**

## 1. Check your Michi installation

The standard Michi installer uses these locations:

| Location | Purpose |
| --- | --- |
| `~/.michi` | Installation checkout, dependencies, and build output. It is also the default location for Michi data and configuration. |
| `~/Applications/michi.app` | Installed macOS desktop application. |
| `~/.kiro/crew` | Default KiroCrew home, including installed Crew Apps. |

Michi must include the **Kiro Crew** runtime and the complete setup helper described here (bundled Crew App manifest **0.5.0 or newer**). Official KiroCrew must be installed and signed in. The Michi installer builds Michi for you; you do not need a separate development checkout or a preview server.

These paths describe an installer-based installation. If you installed only a standalone desktop bundle, a `~/.michi` data directory alone does not contain the setup helper or App manifest; obtain the matching installer/setup resources for that release first.

In a terminal, check the default installation:

```sh
cd "$HOME/.michi"
node --version
kirocrew --version
node -p 'require("./backend/src/agents/crew/app/app.json").version'
ls backend/scripts/crew-setup.cjs \
   backend/src/agents/crew/app/app.json \
   backend/dist/crewAcp.js \
   backend/dist/crewMcp.js
```

Use Node.js **22.19 or newer**. If you installed Michi in a different directory, use that installation directory instead of `~/.michi` throughout this guide. The setup script resolves paths from its own installation, so custom directories work too.

If these Crew files or the runtime are missing, update to a Michi version that includes Crew support using the normal update command:

```sh
michi update
```

On macOS, this rebuilds and replaces the desktop app and quits the running Michi app. Reopen it after the update. A change made only in a developer checkout is not an update to the installed app, and is not available through the installer until it has been published.

## 2. Prepare the Michi App

Start the official KiroCrew application. Its default local Gateway address is `http://127.0.0.1:5476`.

Michi connects through a Crew App named **michi-crew-runtime**. Run this command from the installed Michi directory:

```sh
cd "$HOME/.michi"
node backend/scripts/crew-setup.cjs
```

The helper always prepares **both Michi MCP and Approvals**. There are no feature flags to choose. It prints a line such as:

```text
Prepared App: /.../michi-crew-app-...
```

Use the **actual directory printed on your machine** in the next step. The helper prepares the App files; KiroCrew records installation, permissions, and launch approval through its official setup flow.

The prepared directory is temporary. Use it promptly. After updating Michi, rerun the helper and update the App from the newly printed directory. Preserve the existing App secret and sessions.

## 3. Complete one-time setup in KiroCrew

All steps in this section are required. These are backend setup actions; once complete, daily chats and approvals take place in Michi.

### Install or update the App and grant approval access

1. Open **Apps** in KiroCrew and install the directory printed by the helper. If **michi-crew-runtime** already exists, use the official **Update / Sync** flow from that directory, preserving its secret and sessions.
2. Review and consent to the App's **sessionApproval** permission. An updated App may remain disabled until consent is given.
3. Confirm that the App shows **Enabled**.

**sessionApproval** is the one-time permission that lets Michi receive and answer
Crew's native approval requests. Your day-to-day **Ask / Trust** choice is made in
Michi; granting this integration permission does not automatically approve every tool.

This official permission also covers user-owned Crew chats. Michi restricts its adapter to its own local, unlinked App sessions. Use Michi to control those chats and avoid concurrent control of the same chat from Crew.

### Enable and approve Michi MCP

1. Open **Developer → MCP Management** in Crew.
2. Find **michi-crew-runtime:michi**.
3. Review the Node command and arguments, enable **Stub / Routed**, and approve the launch.
4. Confirm that the relay argument is the absolute path expanded from:

```text
~/.michi/backend/dist/crewMcp.js
```

The helper generates this absolute path automatically, along with the Node executable you used to run it. For a custom installation, the relay path must point into that installation. Keep the installation and the selected Node executable available.

### Restart the Gateway

After active Crew tasks finish or have been stopped, run:

```sh
kirocrew restart --port 5476
```

Use your Gateway's port if you changed it. **Apply & Restart** in Agent Capabilities restarts chat agents; a **Gateway** restart activates newly configured Stub routes and generates the broker route for a newly added template.

If required consent or MCP configuration is missing, Michi reports **Crew setup required** or an incomplete-setup error and blocks new work. Complete the steps above, then return to Michi and retry.

## 4. Open Michi and create a Crew chat

On macOS, launch Michi normally, or run:

```sh
michi
```

On Linux, run `michi start` and open the address it prints; the default is `http://localhost:4649`.

In Michi:

1. Open **Settings → Model** and select **Kiro Crew**, or select it in a new chat's composer Runtime menu.
2. Choose a model and reasoning level.
3. Create a new chat and send a message.

New chats use the **michi-crew** template by default. You can select another template in the composer. Existing sessions retain their template identity when resumed.

The template contains the fixed Michi instructions. Messages carry dynamic context and a short output-format reminder. For short tasks, Medium / High reasoning may be more responsive than Extra high / Max; model latency, Memory retrieval, and queued work also affect response time.

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
| Crew setup required | Run the helper, update the App, complete sessionApproval consent, enable and approve Stub / Routed, then restart the Gateway. |
| Crew is unavailable or a chat cannot start | Run the official Gateway, confirm the App is Enabled, and check the Node executable and ACP build. Custom Gateway URLs must remain loopback addresses. |
| MCP reports missing caller identity | Enable and approve the official Stub / Routed entry, restart the Gateway, and send a new turn from Michi. A plain stdio entry cannot replace the official broker route. |
| MCP uses an old worktree | Run the helper from the current installation, update the existing Crew App, and check its relay argument. |
| Ask does not show a card | Check sessionApproval consent, App enablement, global/per-chat permissions, and Crew's allowlist/global YOLO. |
| Changing Memory does not affect an existing chat | The mode is fixed after creation. Change the default, then start a new chat. |
| Responses are slow | Check reasoning level, queued work, and pending approvals. Try a short message with Medium / High reasoning. |

After changing process-level configuration, restart Michi. Defaults include `CREW_GATEWAY_URL=http://127.0.0.1:5476`, `KIROCREW_HOME=~/.kiro/crew`, and `MICHI_CREW_MCP_DIR=~/.michi/crew-mcp`. Michi and the MCP relay must use the same binding directory. The packaged macOS app reads overrides from `~/.michi/.env`.

## Current limits

The integration supports text/thinking, native tool input/output, model/reasoning/template selection, resume, historical forks, native Memory, Michi MCP, and approvals in Michi.

Official App callers cannot use **same-turn steer**; messages sent while busy are queued for the next turn. Crew can compact automatically, but Michi has no manual Crew compact command. There is no dedicated Crew subagent management interface, and the adapter does not support image/audio attachments. Private Member Memory inheritance has not been verified in a real private Member session.

Real Gateway acceptance was performed with **0.8.0-insider.14** on October 7, 2026, including Memory, resume/fork, MCP isolation, Allow Once, and Deny. The two Trust choices have controlled automated coverage. The October 12 integration checks do not constitute a fresh complete real-provider run against **0.8.0-insider.16**.
