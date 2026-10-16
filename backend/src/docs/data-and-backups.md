# History, deletion, backups and migration

Applies to: local and remote backend data; hosted access is owner-scoped. Source checked: 2026-10-16 against persistence, Trash, export and backup code. Recovery depends on what was actually retained; this is not evidence that your backup has been tested.

## A conversation seems to be missing

Before deleting or resetting anything:

1. Confirm the backend connection and account. A different backend has a different database.
2. Confirm the workspace and active tree. A workspace can contain several trees.
3. Check Home Continue, the workspace Chats list, archived threads/nodes and Trash.
4. Restore connectivity and allow hydration to finish. Backend unavailability is not an empty workspace.

Opening/closing panes affects the view. Clearing browser storage does not restore the authoritative database. Do not replace a database merely because the initial UI looks empty.

## Archive, Trash and permanent deletion

| Action | Meaning | Recovery |
| --- | --- | --- |
| Close a pane | Hide a view | Reopen the item |
| Archive a thread/node | Retain it outside active work; archived views are read-only | Use the corresponding restore/unarchive action |
| Move a thread/workspace to Trash | Soft deletion | Open Trash, preview the item and use Restore |
| Delete permanently / Empty trash | Remove retained application records | Requires an independent prior backup; UI undo cannot restore them |

Trash shows retention status. Automatic removal can be enabled by retention preferences; zero disables automatic deletion. Archived node groups are excluded from that Trash cleanup. Restore needed items before their displayed expiry.

Conversation deletion and project-file deletion are different operations. Removing an application item is not a comprehensive erasure of files, native provider history, external resources, backups or logs. Likewise, restoring a chat does not undo or restore project-file edits.

## Transcript, portable backup and filesystem backup

| Kind | What it preserves | What it does not promise |
| --- | --- | --- |
| Thread Export / Markdown transcript | Readable selected conversation content | Reimportable complete state, project bytes, credentials or native sessions |
| Portable JSON backup | Workspace/tree/node/message/Artifact records; version 2 includes an Agents fragment | Full project directories, attachments as a byte archive, secrets or live native bindings |
| Stopped-backend filesystem backup | Files/databases you explicitly copy | External targets, remote-host data or provider-side state that you omitted |
| Git backup | Tracked project history and pushed commits | Untracked Artifacts/attachments, Michi databases, credentials or every native session |

The current UI's Export is a Markdown flow. There is no general Settings → Backup / Import JSON screen. Do not confuse it with the advanced backup endpoints below.

## Make a complete backup of your work

1. Finish or explicitly stop active work. Quit the local backend before copying its databases; for a remote backend use its documented stop procedure. Do not stop unrelated user processes.
2. Copy the effective data and configuration locations using your normal backup tool. Defaults are under `~/.michi`; custom paths and development data can differ. Keep associated SQLite WAL/SHM files with databases if present; copying only a live `data.db` is not a consistent-backup procedure.
3. Separately copy workspace files, including needed `.contexts/`, `.attachments/` and imported sources. Preserve external symlink/reference targets or document how to reconnect them.
4. Preserve required private configuration/auth material securely, and record runtime versions and custom paths. Native CLI/Crew state lives outside Michi too; use the runtime's own supported backup/auth procedures.
5. Verify the copy in an isolated location with an appropriate Michi version before relying on it. Check workspace counts, a sample transcript, an Artifact and a project file. Do not point a test instance at the production database.

The default `~/.michi` directory contains application state; the public source checkout and dependencies normally live in `~/Michi`. It can be large and include credentials. A backup of that directory alone still misses workspaces elsewhere and native runtime stores.

## Advanced: portable JSON API

These routes are relative to the selected backend's `/api` base and require that backend's normal authentication/owner permissions. They are not public unauthenticated backup links.

| Request | Purpose |
| --- | --- |
| `GET /api/backup/export` | Export accessible owner workspaces |
| `GET /api/backup/export/:workspaceId` | Export one owned workspace |
| `POST /api/backup/import?mode=merge` | Import a validated JSON payload, remapping identities |
| `POST /api/backup/import?mode=replace` | Destructive replacement behavior for matching workspace records; back up the target first |

Use merge into an isolated target when validating portability. Native session IDs/bindings are cleared, workspace folder bindings are sanitized, and local/external paths may need relinking. Imported Run data is not a promise that execution resumes automatically. JSON remains private conversation data even though portable fields are sanitized.

If import fails, keep the original export and error. Check its `app`, version, graph integrity and required version-2 Agents fragment. Do not hand-edit IDs or switch to replace as a generic fix.

## Move to another machine or backend

Install a compatible Michi build, restore/import the chosen data, restore project files, then relink actual workspace folders and configure runtime credentials on the new backend. Recreate remote connection settings and verify a small read before starting writes.

Hosted deployments also depend on persistent `auth.sqlite` and the stable encryption key used for provider credentials. Losing that key can make encrypted keys unreadable. Do not treat copying only `data.db` as complete hosted disaster recovery.

Success check: the intended owner sees the expected history, paths resolve, documents open, and a new small turn works. Compare before/after counts and sample content; the existence of a backup file alone is not restore verification.

Related documents: `configuration`, `privacy-and-data`, `files-and-artifacts`, `sessions-and-recovery`, `remote-backend`.
