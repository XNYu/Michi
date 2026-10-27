# Agent Desk's block code, mirrored

Michi native Pages draw most of Agent Desk's block types with Desk's own component
code (on Mantine, scoped by `../mantine/MichiMantine.tsx`). This directory holds
that code under Desk's own paths (`shared/…`, `src/…` as in `~/agent-desk`), so
the copied files import each other unchanged and a Desk diff applies to them as
it is.

**Desk commit:** the `commit` field of `manifest.json`. Every file listed there
was taken from that commit.

## What is here

- `manifest.json` → `verbatim`: byte-for-byte copies. Do not edit them; fix
  things from outside (a shim, `../richCss/*.css`, `../richRenderers.tsx`).
- `manifest.json` → `patched`: copies with Michi edits, each marked
  `// Michi:`. They leave out what Michi draws itself (thread cards, custom
  blocks). Embedded pages load on a click, without popups, under their real
  domain. Pictures and avatars keep Michi's page permission and private-network
  URL restrictions. Contents navigation preserves native block identities.
- Everything else is a Michi shim standing in for a Desk module the mirrored
  files import:
  - `shared/i18n.ts`: `L()` takes the English side; Michi has no Chinese UI.
  - `shared/desk.ts`: the few types and limits the mirrored files read.
  - `src/desk/blocks/types.ts`: Desk's `BlockProps`, with Michi's block
    context (`../blockTypes.ts`) as `ctx`.
  - `src/desk/blocks/catalog/interactive/useBlockSend.ts`: delegates to the current native page context. Actions and forms prefill the visible Spaces Assistant; polls and choices send only their visible question and selected answer. There is no Desk service or Desk assistant bridge.
  - `src/desk/peek/use-peek.ts`: the contents block finds and lights blocks by
    Michi's page markers.

`../richRenderers.tsx` registers the mirrored renderers for the block types
Michi does not draw itself. Each block is first read with Desk's catalog
(`shared/desk-catalog`, `validateBlock`), the same check Desk makes before it
stores a page, so a renderer only ever sees a block in the shape it expects;
one the catalog will not read shows Michi's one-line label.

## Syncing with a newer Desk

```sh
node scripts/page-block-source-sync.mjs <desk commit>   # default: Desk's HEAD; reads committed files only
git diff -- frontend/src/components/terminal/content/page/vendor-blocks
```

The script rewrites the `verbatim` files from that commit, prints Desk's diff
since the recorded commit for each `patched` file (merge those by hand), lists
other Desk block and shared files that changed (a shim or the block menu may
need the same change), and records the new commit in `manifest.json`. Then
check the shims against what the new files import, run the Desk page tests
(`npm test -w frontend -- src/components/terminal/content/page`), and look at
`?specimen=native-blocks` in each palette.

The native block menu, hover toolbar, drag and history live outside this mirror and follow Michi's product requirements. Do not replace them with Desk's actions when syncing.

Native write validation and tool schemas live in `shared/src/pages/`, not this display catalog. The old labels/values chart format and gallery titles remain supported by `../richRenderers.tsx`. A database is a native database reference; executable components remain in Michi's component library. Containers are atomic content groups; references stay top-level.

Repeated labels in an existing labels/values chart use the original positional renderer so no data is coalesced. Shared stored content, metadata and history are never rewritten by display adapters.
