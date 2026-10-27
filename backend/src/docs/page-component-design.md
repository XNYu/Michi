# Design generated components for Michi Pages

Applies to: native Page composition and the current generated-component sandbox. Source checked: 2026-10-26. This guide records the design conventions and the APIs that actually exist. It does not add a component SDK, style validator or automatic preview tool. Read `pages-and-components` for the source/call contract.

## Choose the smallest supported building block

Use the native block catalog first: prose, metrics, charts, grids, tables and the other built-in types already receive Michi's renderer and interaction treatment. Use a native database view for editable structured rows. Generate a library component only when those choices cannot express the requested behavior, and check the existing library before creating another implementation.

Follow the target page's saved `layoutPreferences.text` and `layoutRules` when organizing content. They are page-local content guidance. Global visual conventions below govern how the UI looks; they do not allow overriding ownership, data access or program-applied section limits.

## Visual conventions

| Area | Convention |
| --- | --- |
| Product controls | English names for buttons, menus, tooltips, empty/error states. Preserve the user's content language; this is not an instruction to translate their page or conversation. |
| Surfaces | Blend into the document with transparent or theme-derived surfaces. Avoid unnecessary outer cards, heavy borders and decorative shadows. |
| Plain-block hover | Reveal the available small action buttons without adding a ring, outline or background to the whole block. |
| List/table hover | Use a subtle theme-derived row tint; keep text and column alignment still. |
| Actions | Prefer compact controls and short labels. Icon-only actions need a name and tooltip. Preserve visible keyboard focus and disabled/error states; the no-hover-ring convention does not remove focus indication. |
| Typography and color | Use the UI font, restrained hierarchy, foreground/muted/accent tokens and tabular figures for comparable numbers. Use status text as well as color. |
| Layout | Fit the host pane, allow labels to wrap, use flexible widths and a sensible reading order. Use horizontal overflow for genuinely wide tables instead of clipping information. |
| Updates | Keep stable content visible, preserve user drafts and selection where supported, and show honest loading/empty/error states. Do not clear useful content before a replacement succeeds. |
| Evidence | Keep Sources attached to the actual information they support and use native Michi navigation. Do not add a permanent provenance/Undo footer or return-to-external-agent controls. |

These are authoring conventions. Native blocks implement the page chrome and hover behavior; custom code does not automatically inherit every behavior in this table.

## What the sandbox already supplies

The host sends its palette and font variables on load and on theme changes. The fixed frame starts transparent, uses `--term-fg` for text and `--ui-font` for the font family, and gives ordinary buttons, inputs, selects, textareas, tables and focus outlines basic styles. Use semantic elements rather than recreating them with clickable spans.

Available variables:

| Purpose | Tokens |
| --- | --- |
| Surfaces | `--term-bg`, `--term-surface`, `--term-alt`, `--term-alt2` |
| Text | `--term-fg`, `--term-mid`, `--term-muted`, `--term-faint` |
| Borders | `--term-line`, `--term-line-s` |
| Accent/selection | `--term-accent`, `--term-accent-f`, `--term-select`, `--term-select-f` |
| Other semantic colors | `--term-digest`, `--term-digest-f`, `--term-mauve`, `--term-mauve-f`, `--term-danger`, `--term-danger-text` |
| Fonts | `--ui-font`, `--font-mono` |

For example, set `label.style.color = 'var(--term-muted)'` and `container.style.borderColor = 'var(--term-line)'`. Use tokens instead of fixed light/dark colors. Existing frame styles use a 13px/1.5 text baseline and 5px control radii; they do **not** yet follow the native `--fs-*` scale or `--ui-radius` preference. Spacing, density and motion tokens are not in the theme bridge. Do not claim those settings already propagate into a custom frame.

## Author within the supported API

Generated source runs as plain JavaScript in an isolated worker with virtual `root`, `document`, frozen `props`, host-scoped `data` and async `call`. It has no React/Mantine imports, browser DOM, external packages, arbitrary network, `innerHTML`, SVG or canvas. Native Pages may use React/Mantine internally; that does not expose those libraries to generated source.

Virtual elements accept bounded text, styles, supported attributes and `click`/`input`/`change` handlers. There are no mouse-enter/focus handlers for building a custom hover system, no stylesheet element and no native UI class library inside the frame. Assigning an outer-app CSS class will not load that app's CSS. The frame has a button hover style but no general list/table-row hover style or native floating-tooltip primitive.

Use visible text labels when possible. An icon-only control can use supported `title` and `aria-label` attributes, but `title` is only the browser's basic tooltip, not Michi's styled hover/focus tooltip. Avoid promising custom interactions the current sandbox cannot implement; prefer native blocks for those cases. Do not remove or bypass sandbox restrictions to obtain a visual effect.

Use `globalThis.onMichiComponentUpdate` to receive new host props/data without rerunning component source. Keep component state deliberately and avoid unnecessary tree replacement in your code. The current frame renderer still rebuilds DOM from submitted trees: input focus, caret and scroll preservation within a custom frame are not guaranteed by this API. The separate last-successful-frame mechanism prevents blank replacement on source-load failure; it is not an input-state preservation guarantee.

A minimal supported theme-aware rendering pattern is:

```js
const label = document.createElement('p');
label.style.margin = '0';
label.style.color = 'var(--term-muted)';
root.appendChild(label);
function update(nextProps) {
  label.textContent = String(nextProps.label ?? 'No data yet');
}
update(props);
globalThis.onMichiComponentUpdate = update;
```

For database views, values are keyed by stable column IDs; respect the supplied filters/grouping and identify incomplete data. Only an authorized custom database view can request `write.rows`; a Page component cannot. Read revisions and applied/proposed/rejected results. Do not treat a completed agent reply as a completed business task or infer missing execution state as idle/success.

## Generate, save and verify

1. Read the target page/database, current layout preferences, this design guide and the `pages-and-components` contract. Read the component library and the source/schema of any component you plan to reuse.
2. Choose native blocks or a custom view based on actual capabilities. For custom source, use the supported tokens and simple semantic elements; keep loading, empty, error and partial-data states explicit.
3. Save with the current library revision. Saving creates an immutable **active** version, so enabled unpinned hosts may update. A new host needs a separate attachment. Pin a version when that host should not follow later library saves.
4. Inspect the native Components preview where available, then the intended host with representative data. The current tool catalog has no dedicated agent component-preview/visual-validation tool. Preview data is a small sample and host capabilities are unavailable there.
5. With browser/UI tooling actually available to the session, inspect light/dark themes, a narrow pane, long labels, keyboard focus, actions and data refresh. Verify persistence/receipts separately. If you cannot run the UI, report source/save/readback evidence and say that rendering remains unverified.

The host retains the last successful frame while a candidate source version loads; the old worker loses its actions, and the candidate cannot write/navigate/fill drafts until activation. A first-render failure keeps the old view. This behavior does not undo the saved active library version or prove the replacement's design is correct.

## Follow-up design-system work, not available APIs

A fuller implementation would share radius/type/spacing tokens with native Pages; provide trusted sandbox styles or primitives for compact actions, rows, tooltips and empty states; add matching examples; and validate representative theme/width/interaction cases. Code/style checks can flag some violations but cannot prove visual quality.

Those primitives, extra tokens and automated design checks have **not** been implemented by this documentation update. They should be introduced with explicit compatibility/version handling so existing saved components retain their behavior. The unified Tasks Overview/Table/Board/Milestones feature is also still a proposal; existing static blocks and native database views must not be described as that finished feature.

Related documents: `pages-and-components`, `pages-maintenance`, `permissions`, `privacy-and-data`, `troubleshooting`.
