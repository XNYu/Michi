/**
 * Which kind of input last acted on the page.
 *
 * A tap fires compatibility `mouseover`/`mouseenter` (and on Android a focus)
 * after the touch, but no `mouseleave` until the next tap lands elsewhere. A
 * hover tooltip opened by that synthetic hover therefore stays on screen.
 * Hover-driven surfaces ask `lastInputWasTouch()` before they open.
 *
 * Pointer events carry the real `pointerType` and fire before the
 * compatibility mouse events, so a capture listener on them is enough: a mouse
 * moving over any element reports `mouse` before its `mouseenter` runs.
 */
type Modality = 'mouse' | 'touch' | 'keyboard';

let modality: Modality = 'mouse';
let installed = false;

function fromPointer(event: PointerEvent) {
  modality = event.pointerType === 'touch' || event.pointerType === 'pen' ? 'touch' : 'mouse';
}

function fromKey() {
  modality = 'keyboard';
}

export function installInputModality(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const options = { capture: true, passive: true } as const;
  document.addEventListener('pointerover', fromPointer, options);
  document.addEventListener('pointerdown', fromPointer, options);
  document.addEventListener('keydown', fromKey, options);
}

/** True when the most recent pointer or key input was a finger or pen. */
export function lastInputWasTouch(): boolean {
  return modality === 'touch';
}

installInputModality();
