# Optional interactions in Michi Pages

Pages can support research, comparison, reading, visualization or tasks. Use interaction capabilities when they help the person's current activity. Static pages are valid: there is no requirement to make every number clickable or to add a task table.

## Entry, content and presentation

A `view` names an ordered selection of existing content blocks on the same page. A reusable action `{type:"open-view",viewId,presentation?}` opens that selection. Presentation can be `inline` (below the entry's block), `drawer` (beside the page, the default), or `modal` (a dialog).

Content may be prose, comparisons, charts, grids, task views, database references, versioned components, or any other native content block. References use the original blocks and their revisions, sources, ownership and permissions. Opening does not create a new copy, write the page, grant more permissions or start an agent run.

## Authoring

1. Read the page. Use `edit_page` to prepare content blocks and read their real server-assigned IDs. A top-level content block can set `visibility:"detail"` to appear only inside views. Omit this field to also keep it in the ordinary page flow. Changing visibility on human-edited content follows normal proposal protection.
2. Define a view using those existing IDs, and add one or more entries. `viewId` is a stable name within this page (a letter followed by letters, digits, `_` or `-`, at most 80 characters). It is distinct from the server-assigned block ID. Definitions are top-level blocks, with 1–40 distinct content IDs; they do not refer to other definitions. Entries and definitions may be saved together in one atomic edit.
3. Use the current block revisions for later changes. Remove or update references when deleting a target. Existing page block, size and nesting limits still apply, including to detail content. View navigation may link to other views; the host supplies Back and reuses the current presentation.

The following uses illustrative block IDs. Replace them with IDs returned by the page; metadata such as `id` and `rev` is never supplied inside insert content.

```json
{
  "type": "view",
  "viewId": "why-a",
  "title": "Why option A",
  "blockIds": ["block-real-evidence", "block-real-comparison"]
}
```

```json
{
  "type": "view-link",
  "label": "Why recommend A?",
  "action": {"type": "open-view", "viewId": "why-a", "presentation": "drawer"}
}
```

The same action can be attached as `interaction:{label,action}` to any content block: a comparison can offer “Read the evidence”, a chart “Explore this dataset”, or a task-related block “Background”. Existing controls keep their own behavior. A metric item can carry `action` directly to make its value the entry; other metric items may remain static.

Markdown text can use `[Read the evidence](#view/why-a)` or `[Show details](#view/why-a?presentation=inline)`. These links resolve only in the current native page. External HTTPS links keep their usual behavior. A missing target is shown as unavailable; content from another page is never substituted.

## Behavior and limits

Detail content mounts only when opened. Back keeps earlier views mounted so local input, selection and scroll can survive; the navigation path is bounded to ten views. Closing discards transient detail state and returns focus to the entry. Saved content and native data remain in their ordinary stores, and live updates can refresh an open view. Different page/workspace/backend identities have separate interaction state.

View content retains its original edit and Sources actions. Read-only pages stay read-only. Referenced databases and components use the page's existing host bindings, versions and disabled-state checks. A count is not automatically recalculated merely because it opens a list: use a live native database/task view where appropriate, and keep static claims tied to their evidence and time.

Undo and redo preserve the reference graph. For a page with named views, the same page's changes in a history batch replay together; a conflicting later edit leaves that group unchanged. Reverting just a definition that still has entries is refused until its references are updated.

The capability is available on native Pages and their embedded previews. It does not add a global cross-page event bus, parameter expression language, arbitrary API calls, shareable subpage routes, per-chart-point actions, or generation triggered on click. Those require separate contracts. No special skill system or mandatory layout rule is required; `edit_page` exposes the schemas and `michi_docs` can discover this guide with `interactions` or `页面交互`.
