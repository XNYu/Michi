# Complete common tasks with Michi

Applies to: ordinary chats with the relevant Michi tools available. Source checked: 2026-10-16. These are example workflows, not claims that a task has already run. Custom Agent Runs require the separate experimental feature.

## Research alternatives and make a decision

Goal: compare alternatives, preserve evidence and keep the final choice with you.

1. Create a workspace for the research and start a root chat. State the question, constraints and evidence standard.
2. Ask for explicit branches, for example:

   > Create three research branches comparing A, B and C. Each should report sources, tradeoffs and unresolved questions. Do not make a purchase or change any accounts.

3. Keep branches in separate panes. Use Overview to catch up and read original passages when a claim matters. `spawn_branches` supports at most five children per call.
4. Select relevant chats and use Weave for a comparison conversation, or Digest for a source-connected synthesis. These do not imply the source transcripts were all copied verbatim.
5. Ask the synthesis to cite evidence, identify disagreements and recommend a choice under your constraints. Correct assumptions before accepting the decision.
6. Save the reviewed result as an Artifact, including sources, decision criteria and open questions.

Success check: each alternative has traceable evidence; the comparison reflects the constraints; the saved Artifact can be read from a new chat. If sources change, re-read them and rebuild the synthesis.

## Implement a feature and verify it

Goal: make a scoped change with inspectable evidence.

1. Choose the repository workspace and confirm its backend/path. Preserve unrelated edits.
2. Start with a concrete behavior and acceptance criteria:

   > Inspect the current implementation. Fix this reproduction case, preserve unrelated changes, run the relevant checks and report exactly what was verified. Ask before expanding the scope.

3. For parallel implementation, create separate Git worktrees and separate workspaces pointing to them first. Ordinary conversation branches share files unless you explicitly arrange isolation.
4. Supply the relevant spec/Artifact and project instructions. Ask for a short plan when the change spans several modules.
5. Inspect tool activity, approval requests and changed-file receipts. A receipt/diff helps inspect work but does not itself prove correctness or assign exclusive ownership of every displayed change.
6. Run appropriate tests/build checks for the behavior. Ask the agent to distinguish automated checks, real-provider checks and unverified cases.
7. Request review in a separate branch/chat with the exact path and diff scope. Ask it to inspect current files, not just the implementer's description.
8. Resolve findings, inspect the final diff and explicitly decide whether to commit, merge or publish.

Success check: the reproduction is fixed, evidence matches the requested behavior, unrelated changes remain intact and remaining limits are disclosed. A green mock test alone does not prove real-runtime compatibility.

## Review existing work without editing

Open the repository workspace and ask:

> Review the current changes for correctness and regressions. Read the relevant implementation and tests. Report actionable findings with file locations and reproduction conditions. Do not edit or commit.

If multiple chats share the directory, state the exact base/ref or file set. A new review conversation does not freeze the files. Finish with findings and supporting evidence, including when no actionable issue was found.

## Continue a long-running investigation

1. Reopen the original chat and wait for history/activity to hydrate.
2. Read Overview, then ask for the exact source messages/files behind uncertain details.
3. State the new constraint or next goal. Use steering if supported, otherwise queue the next turn.
4. Save a compact handoff Artifact containing the goal, current state, paths, verification, pending decisions and sources.

Example:

> Read `@handoff.md`, verify the current files and task status, then continue the next unresolved item. Do not repeat completed external actions.

Success check: the agent confirms current state before acting. Saved history, a handoff summary and native Memory have different scopes; none removes the need to verify drift-prone facts.

## Share a result or hand it to another chat

Use a reviewed Artifact for the deliverable and thread Export for a readable transcript. Remove private content before sharing externally. If asking an agent to message another chat through `send_to_thread`, expect the user approval workflow; tool access alone is not authorization to dispatch work elsewhere.

When experimental Runs are enabled, Continue as Branch can import selected Run task/result/transcript material. It does not merge a Run worktree automatically. See `custom-agents`.

Related documents: `concepts-and-context`, `files-and-artifacts`, `sessions-and-recovery`, `permissions`, `data-and-backups`.
