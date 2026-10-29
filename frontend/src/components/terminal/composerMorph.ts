import { prefersReducedMotion } from '../../hooks/useReducedMotion';

/**
 * The phone composer's open/close animation (ComposerShell, collapsible).
 *
 * React commits the new layout at once, so the composer's box already has
 * its final size when this runs. The frame (background, border, shadow) is
 * drawn on a stand-in element whose top edge moves from the old height to
 * the new one, the controls and the text slide from where they were, the
 * toolbar chips that appear fade in and the ones that leave fade out as
 * copies. Only the composer animates: its layout height changes once, so
 * the pane above it reflows once.
 */

/** A box relative to the composer's bottom-left corner, which stays put. */
interface Box { x: number; y: number; w: number; h: number }

/** The frame's colours and shadow, which change with focus. */
interface Look { backgroundColor: string; borderColor: string; boxShadow: string }

export interface ComposerSnapshot {
  height: number;
  look: Look;
  /** Toolbar controls that are laid out (display: none ones are absent). */
  controls: Map<HTMLElement, Box>;
  /** The text field; the caret row moves by its offset. */
  field: Box | null;
}

const CONTROLS = '.terminal-composer__toolbar :is(.t-toolbar-chip, .t-action-btn, .composer-context-ring)';
const FIELD = '.terminal-composer__input :is([contenteditable="true"], textarea, [role="textbox"])';

function boxOf(el: Element, origin: DOMRect): Box | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left - origin.left, y: r.top - origin.bottom, w: r.width, h: r.height };
}

function lookOf(style: CSSStyleDeclaration): Look {
  return { backgroundColor: style.backgroundColor, borderColor: style.borderTopColor, boxShadow: style.boxShadow };
}

/** What is on screen now, including a colour transition in progress. */
export function snapshotComposer(root: HTMLElement): ComposerSnapshot {
  const origin = root.getBoundingClientRect();
  const controls = new Map<HTMLElement, Box>();
  root.querySelectorAll<HTMLElement>(CONTROLS).forEach((el) => {
    const box = boxOf(el, origin);
    if (box) controls.set(el, box);
  });
  const field = root.querySelector(FIELD);
  return { height: origin.height, look: lookOf(getComputedStyle(root)), controls, field: field ? boxOf(field, origin) : null };
}

/** Where the frame's colour transition (focus) ends: the look to animate to. */
function settledLook(root: HTMLElement): Look {
  const transition = root.style.transition;
  root.style.transition = 'none';
  const look = lookOf(getComputedStyle(root));
  root.style.transition = transition;
  return look;
}

export function composerMotionAllowed(): boolean {
  if (typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function') return false;
  return !prefersReducedMotion(document.documentElement.dataset.reduceMotion === 'on');
}

/** The --t-enter duration and --t-ease curve, read from the theme. */
function timing(): { duration: number; easing: string } {
  const style = getComputedStyle(document.documentElement);
  const raw = style.getPropertyValue('--t-enter').trim();
  const value = parseFloat(raw);
  const duration = Number.isFinite(value) ? (raw.endsWith('ms') ? value : raw.endsWith('s') ? value * 1000 : value) : 180;
  return { duration: duration > 0 ? duration : 180, easing: style.getPropertyValue('--t-ease').trim() || 'ease-out' };
}

/**
 * Animate from `prev` to `next`, both taken after a commit. Returns a
 * function that ends the animation at once and removes what it added;
 * `onDone` runs once either way.
 */
export function morphComposer(
  root: HTMLElement,
  frame: HTMLElement,
  prev: ComposerSnapshot,
  next: ComposerSnapshot,
  onDone: () => void,
): () => void {
  const { duration, easing } = timing();
  const animations: Animation[] = [];
  const ghosts: HTMLElement[] = [];
  const play = (el: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    try {
      animations.push(el.animate(keyframes, { duration, easing, ...options }));
    } catch {
      // An easing the browser rejects: no animation rather than a broken one.
    }
  };

  // The stand-in frame takes over from the composer's own background, border
  // and shadow (data-morphing), and moves from the old look to the new one.
  const final = settledLook(root);
  const style = getComputedStyle(root);
  const border = parseFloat(style.borderTopWidth) || 0;
  Object.assign(frame.style, {
    left: `${-border}px`,
    right: `${-border}px`,
    bottom: `${-border}px`,
    borderStyle: style.borderTopStyle,
    borderWidth: style.borderTopWidth,
    borderRadius: style.borderRadius,
    ...final,
  });
  root.setAttribute('data-morphing', '');
  play(frame, [
    { top: `${next.height - prev.height - border}px`, ...prev.look },
    { top: `${-border}px`, ...final },
  ], {});

  const slide = (el: HTMLElement, from: Box, to: Box) => {
    const dx = from.x - to.x;
    const dy = from.y - to.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    play(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {});
  };

  const caretRow = root.querySelector<HTMLElement>('.terminal-composer__input');
  if (caretRow && prev.field && next.field) slide(caretRow, prev.field, next.field);

  for (const [el, to] of next.controls) {
    const from = prev.controls.get(el);
    if (from) slide(el, from, to);
    // Late, so the frame has made room before it shows.
    else play(el, [{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], {});
  }

  // Chips that leave fade out as copies where they were: the real ones are
  // already display: none. Copies are placed from the padding box.
  for (const [el, from] of prev.controls) {
    if (next.controls.has(el) || !el.isConnected) continue;
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.removeAttribute('id');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.setAttribute('inert', '');
    ghost.classList.add('terminal-composer__ghost');
    ghost.style.setProperty('display', 'inline-flex', 'important');
    Object.assign(ghost.style, {
      left: `${from.x - border}px`,
      top: `${next.height + from.y - border}px`,
      width: `${from.w}px`,
      height: `${from.h}px`,
    });
    root.appendChild(ghost);
    ghosts.push(ghost);
    play(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: duration * 0.6, fill: 'forwards' });
  }

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    for (const animation of animations) animation.cancel();
    for (const ghost of ghosts) ghost.remove();
    // Hand the frame back without its colour transition replaying from
    // transparent: apply the change with transitions off, then restore them.
    const transition = root.style.transition;
    root.style.transition = 'none';
    root.removeAttribute('data-morphing');
    void getComputedStyle(root).backgroundColor;
    root.style.transition = transition;
    onDone();
  };
  const frameAnimation = animations[0];
  if (frameAnimation?.effect && (frameAnimation.effect as KeyframeEffect).target === frame) {
    frameAnimation.addEventListener('finish', cleanup);
    frameAnimation.addEventListener('cancel', cleanup);
  } else {
    cleanup();
  }
  return cleanup;
}
