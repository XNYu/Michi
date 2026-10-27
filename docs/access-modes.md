# Authentication and owner migration

| REQUIRE_AUTH | CLOUD | Contract |
|---|---|---|
| off | off | Local desktop, protected by local origin checks or configured remote bearer access. |
| on | off | Personal authenticated desktop. Requires exactly one `MICHI_LOCAL_AUTH_EMAIL` and a verified matching session. The selected person can access all local data. |
| off | on | Unsupported. Startup fails before starting runtimes. Enable auth or turn cloud off. |
| on | on | Multi-user hosting. Requests require a session and workspaces/files/runtime settings are isolated by owner. |

`MICHI_ADMIN_EMAILS` is an independent allowlist in both authenticated modes.
An empty list, an unverified email, or a session for a different email never
grants admin access. Cloud authentication does not confer admin rights.
The Docker image defaults to both auth and cloud on; OAuth configuration,
persistent `/data`, and the existing encryption key remain deployment inputs.

The HTTP session gate keeps the authenticated principal in `req.authUser`.
Only cloud mode also sets `req.user`, which existing services use as their
data owner. Local auth therefore continues to use shared local credentials,
the desktop Agent identity, and ownerless workspace history. Do not manually
inject a login identity as a desktop data owner in new request adapters.
Local CLI subprocesses may access only the existing loopback MCP slot/group
and Codex stop-hook capability routes without a browser cookie; those routes
still validate their own slot and active-session binding. This exception does
not include ordinary API paths and does not apply in cloud mode.

Request-facing persistence routes apply `requireRequestAccess` and obtain
their owner through `requestOwnerUserId`. A missing cloud owner is rejected;
it must never be passed as `undefined` to a trusted repository read. Internal
background inventory and administration may intentionally omit `userId` to
read all workspaces. An explicit empty owner remains scoped to no user.

## Existing authenticated deployments without CLOUD

For a personal installation, add `MICHI_LOCAL_AUTH_EMAIL=your-verified-email`.
This is an explicit grant over the entire local installation. Do not choose
personal mode for a database containing data that must remain isolated between
different people. Local provider keys and workspace directories stay in place.

For multi-user hosting, enable `MICHI_CLOUD=1`. Workspaces that already have a
valid `owner_user_id` remain owned by that account. Ownerless workspaces are
hidden until an operator assigns each one explicitly. There is no first-login
claim or automatic bulk reassignment.

1. Stop the backend and any other writer to this data directory. Back up the
   persistent volume, including `data.db`, `auth.sqlite` and attached WAL/SHM
   files, before modifying ownership. Retain the existing auth secret and
   encryption key; do not regenerate them.
2. With an operator SQLite client, inspect verified users in `auth.sqlite`:
   `SELECT id, email, emailVerified FROM "user";`. Current Better Auth uses
   camelCase column names. Record the exact stable account id of the intended
   owner after checking their email; do not infer it from a workspace title.
3. Inspect candidate records in `data.db`:
   `SELECT id, name, owner_user_id FROM workspaces WHERE owner_user_id IS NULL;`.
   Review each workspace's intended owner. Leave ambiguous records hidden.
4. In `data.db`, assign only the reviewed ids, using a transaction such as:

   ```sql
   BEGIN IMMEDIATE;
   UPDATE workspaces SET owner_user_id = 'reviewed-auth-user-id'
   WHERE id IN ('reviewed-workspace-id') AND owner_user_id IS NULL;
   SELECT changes();
   SELECT id, name, owner_user_id FROM workspaces
   WHERE id IN ('reviewed-workspace-id');
   COMMIT;
   ```

   Replace the illustrative ids with verified values and check the changed row
   count before committing. Use `ROLLBACK` if the selection is wrong. Existing
   non-null owners are preserved by the condition.
5. Cloud file access uses its user/workspace sandbox instead of arbitrary
   desktop `cwd` paths. Preserve original files in the backup and upload needed
   files through the intended user's cloud workspace. Configure each user's
   runtime/provider settings explicitly. Shared desktop keys/config are not
   silently copied into user accounts. Existing encrypted per-user keys in
   `data.db` remain usable with the same account ids and encryption key.
6. Restart with both flags enabled. Sign in as each affected user and check
   workspace listing, full hydration, tree messages, file access and provider
   readiness. A different user must receive 404 for another owner's workspace.

The migration changes workspace ownership only. It does not move accounts,
change provider-key encryption, or assign previously ownerless Agent runs and
other independent owner-scoped records; review those separately if they exist.
