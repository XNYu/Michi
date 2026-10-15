# Michi Crew App

This is the complete portable App source for checkouts installed at `~/.michi`. The public installer uses `~/Michi`; for that path, run `node backend/scripts/crew-setup.cjs` from the built checkout and use its generated App source as described in the setup guide. Install directly from your absolute `~/.michi/crew-app` path in Crew's **Install from path**. Michi MCP and sessionApproval are included and required.

After `michi update`, use **Sync** on the existing Michi App in Crew. Keep this registered source directory. Complete any renewed launch approval. After first installation or migration from an App older than 0.6.0, restart the Gateway after active work finishes, even if Sync does not prompt. Later host/launcher/API changes require a new process.

Crew resolves the manifest's bare Python command. The stdlib launcher finds the installation via the user's home, and uses the supported Node recorded by the backend build. Compatible relay handlers refresh inside the existing MCP host without disconnecting ongoing calls. Launcher/host/API changes require a new process.

Custom installations and existing generated sources use `backend/scripts/crew-setup.cjs`. Do not copy generated custom manifests over this canonical directory.

Read the [complete setup guide](../backend/src/agents/crew/GETTING_STARTED.md) before granting the official sessionApproval and MCP permissions.
