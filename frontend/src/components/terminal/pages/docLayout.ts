/**
 * The document-page layout shared by the branch overview and Michi's workspace
 * document: a paper sheet (`article.branches-document`) on a soft field with
 * a sticky outline card (`.branches-directory`) to its right. Pages inject it
 * with `<style>{BRANCHES_LAYOUT_CSS}</style>` and set
 * `--branches-viewport-height` on their scroller.
 */
export const BRANCHES_LAYOUT_CSS = `
  .branches-layout {
    width: min(1160px, calc(100% - 48px));
    margin: 0 auto;
    /* Top pad clears the floating Graph/Timeline/Doc switcher (top:8, ~30px). */
    padding: 52px 0 64px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 236px;
    column-gap: 32px;
    align-items: start;
  }
  /* The document is a paper sheet floating on the soft field. */
  .branches-document {
    grid-column: 1;
    grid-row: 1;
    min-width: 0;
    background: var(--term-surface);
    border: 1px solid color-mix(in srgb, var(--term-fg) 7%, transparent);
    box-shadow: 0 2px 6px color-mix(in srgb, var(--term-fg) 4%, transparent),
      0 20px 50px -30px color-mix(in srgb, var(--term-fg) 25%, transparent);
    padding: 48px 56px 64px;
  }
  /* The outline is a sticky glass card beside the sheet. */
  .branches-directory {
    grid-column: 2;
    grid-row: 1;
    position: sticky;
    /* Pin below the floating switcher so a scrolled outline never slides under it. */
    top: 48px;
    align-self: start;
    /* The shell's topbar makes the actual scroller shorter than the window.
       Reserve the initial 52px inset as well as the sticky 48px inset. */
    max-height: calc(var(--branches-viewport-height, 100dvh) - 52px);
    overflow-y: auto;
    /* Wheeling past the outline's end must not scroll the document: that
       would move the current section and yank the outline back to it. */
    overscroll-behavior: contain;
    background: color-mix(in srgb, var(--term-surface) 82%, transparent);
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    border: 1px solid color-mix(in srgb, var(--term-fg) 8%, transparent);
    box-shadow: 0 12px 36px -18px color-mix(in srgb, var(--term-fg) 30%, transparent);
    padding: 16px 0 10px;
  }
  .branches-directory__item {
    width: 100%;
    display: block;
    border: 0;
    border-left: 2px solid transparent;
    background: transparent;
    color: var(--term-mid);
    font-family: var(--ui-font);
    font-size: var(--fs-md);
    line-height: 1.5;
    text-align: left;
    overflow-wrap: anywhere;
    white-space: normal;
    cursor: pointer;
    transition: color var(--t-quick), background var(--t-quick), border-color var(--t-quick);
  }
  .branches-directory__item:hover { color: var(--term-fg); background: color-mix(in srgb, var(--term-accent-f) 30%, var(--term-surface)); }
  .branches-directory__item:focus-visible { outline: 1px solid var(--term-accent); outline-offset: -1px; }
  .branches-directory__item.is-current { color: var(--term-fg); border-left-color: var(--term-accent); background: color-mix(in srgb, var(--term-accent-f) 30%, var(--term-surface)); font-weight: 600; }
  @media (max-width: 860px) {
    .branches-layout { width: min(760px, calc(100% - 36px)); display: block; }
    .branches-directory { position: static; max-height: none; overflow: visible; margin-top: 20px; }
    .branches-document { padding: 32px 28px 48px; }
  }
`;
