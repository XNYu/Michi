import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  cameraTransform,
  clampCamera,
  sameCamera,
  wheelDeltaPixels,
  wheelZoomFactor,
  zoomAt,
  type Camera,
  type Point,
  type Size,
} from './mapCamera';

// Imperative pan/zoom camera for the Map graph view.
//
// Every gesture writes `transform: translate3d() scale()` straight onto the
// world element inside one requestAnimationFrame, so pinch and pan never
// re-render the React tree of cards and edges. While a gesture is running the
// world gets `will-change: transform` (one GPU layer, scaled by the
// compositor) and `pointer-events: none` (no hover hit-testing as cards slide
// under the cursor). Both are dropped once input goes idle, which makes Chrome
// re-raster the text crisply at the final scale.

/** Idle time after the last wheel/gesture event before the gesture ends. */
const SETTLE_MS = 140;
/** Duration of animated camera moves (button zoom, FIT, auto re-framing). */
const TWEEN_MS = 220;
/** Pointer travel before a press on empty canvas counts as a pan. */
const DRAG_SLOP = 3;
const BUTTON_ZOOM_STEP = 1.2;

export type CameraSnapshot = { k: number; auto: boolean };

export type MapCameraController = {
  /** Callback ref for the clipping surface that receives input. */
  bindSurface: (el: HTMLDivElement | null) => void;
  /** Callback ref for the transformed world element. */
  bindWorld: (el: HTMLDivElement | null) => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => CameraSnapshot;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Return to auto framing (animated). */
  fit: () => void;
  /** Return to auto framing without animating (e.g. on thread switch). */
  resetToAuto: () => void;
};

type Tween = { from: Camera; to: Camera; start: number };
type Drag = { pointerId: number; x: number; y: number; from: Camera; moved: boolean };

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    k: a.k + (b.k - a.k) * t,
  };
}

// Safari reports trackpad pinch as non-standard GestureEvents.
type SafariGestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };

export function useMapCamera({
  viewport,
  content,
  autoTarget,
}: {
  viewport: Size;
  content: Size;
  /** Camera for auto framing; null until the viewport has been measured. */
  autoTarget: Camera | null;
}): MapCameraController {
  const camRef = useRef<Camera>({ x: 0, y: 0, k: 1 });
  const autoRef = useRef(true);
  const initializedRef = useRef(false);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const frameRef = useRef(0);
  const tweenRef = useRef<Tween | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interactingRef = useRef(false);

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const contentRef = useRef(content);
  contentRef.current = content;
  const autoTargetRef = useRef(autoTarget);
  autoTargetRef.current = autoTarget;

  // Tiny external store so only the zoom pill re-renders on zoom changes.
  const snapshotRef = useRef<CameraSnapshot>({ k: 1, auto: true });
  const listenersRef = useRef(new Set<() => void>());

  const publish = useCallback(() => {
    const k = Math.round(camRef.current.k * 100) / 100;
    const auto = autoRef.current;
    const prev = snapshotRef.current;
    if (prev.k === k && prev.auto === auto) return;
    snapshotRef.current = { k, auto };
    for (const l of listenersRef.current) l();
  }, []);

  const write = useCallback(() => {
    const el = worldRef.current;
    if (el) el.style.transform = cameraTransform(camRef.current);
    publish();
  }, [publish]);

  const tick = useCallback((now: number) => {
    frameRef.current = 0;
    const tween = tweenRef.current;
    if (tween) {
      const t = Math.min(1, (now - tween.start) / TWEEN_MS);
      camRef.current = t >= 1 ? tween.to : lerpCamera(tween.from, tween.to, easeOutCubic(t));
      if (t >= 1) tweenRef.current = null;
    }
    write();
    if (tweenRef.current) frameRef.current = requestAnimationFrame(tick);
  }, [write]);

  const schedule = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(tick);
  }, [tick]);

  const clampToContent = useCallback(
    (cam: Camera) => clampCamera(cam, viewportRef.current, contentRef.current),
    [],
  );

  const animateTo = useCallback((target: Camera) => {
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      tweenRef.current = null;
      camRef.current = target;
    } else {
      tweenRef.current = { from: camRef.current, to: target, start: performance.now() };
    }
    schedule();
  }, [schedule]);

  const setInteracting = useCallback((on: boolean) => {
    const el = worldRef.current;
    interactingRef.current = on;
    if (!el) return;
    el.style.willChange = on ? 'transform' : '';
    el.style.pointerEvents = on ? 'none' : '';
  }, []);

  /** Mark a burst of wheel/gesture input; ends SETTLE_MS after the last one. */
  const touchInteraction = useCallback(() => {
    if (!interactingRef.current) setInteracting(true);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      setInteracting(false);
    }, SETTLE_MS);
  }, [setInteracting]);

  /** Apply a user-driven camera change on the next frame. */
  const userMove = useCallback((next: Camera) => {
    tweenRef.current = null;
    autoRef.current = false;
    camRef.current = clampToContent(next);
    schedule();
  }, [clampToContent, schedule]);

  // Auto framing: snap on first measurement, animate on later re-frames
  // (layout engine swap, card expand, resize). Layout effect so the first
  // frame paints already framed.
  useLayoutEffect(() => {
    if (!autoTarget || !autoRef.current) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      tweenRef.current = null;
      camRef.current = autoTarget;
      write();
      return;
    }
    const goal = tweenRef.current?.to ?? camRef.current;
    if (!sameCamera(goal, autoTarget)) animateTo(autoTarget);
  }, [autoTarget, animateTo, write]);

  // Wheel, Safari gesture and drag-pan listeners. Native listeners because
  // React registers wheel as passive, which makes preventDefault a no-op and
  // lets a pinch zoom the whole page instead of the map.
  useEffect(() => {
    if (!surface) return;
    let gestureActive = false;
    let gestureStartK = 1;
    let drag: Drag | null = null;

    const localPoint = (clientX: number, clientY: number): Point => {
      const rect = surface.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (drag) return;
      const cam = camRef.current;
      if (e.ctrlKey || e.metaKey) {
        // Chromium reports trackpad pinch as ctrlKey wheel. Safari sends
        // GestureEvents too, so skip the wheel copy while one is active.
        if (gestureActive) return;
        const dy = wheelDeltaPixels(e.deltaY, e.deltaMode, surface.clientHeight);
        userMove(zoomAt(cam, localPoint(e.clientX, e.clientY), wheelZoomFactor(dy)));
      } else {
        let dx = wheelDeltaPixels(e.deltaX, e.deltaMode, surface.clientWidth);
        let dy = wheelDeltaPixels(e.deltaY, e.deltaMode, surface.clientHeight);
        // Mouse wheels without a horizontal axis: shift+wheel pans sideways.
        if (e.shiftKey && dx === 0) { dx = dy; dy = 0; }
        userMove({ ...cam, x: cam.x - dx, y: cam.y - dy });
      }
      touchInteraction();
    };

    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureActive = true;
      gestureStartK = camRef.current.k;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as SafariGestureEvent;
      const cam = camRef.current;
      userMove(zoomAt(cam, localPoint(g.clientX, g.clientY), (gestureStartK * g.scale) / cam.k));
      touchInteraction();
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gestureActive = false;
    };

    const onPointerDown = (e: PointerEvent) => {
      // Pan only from empty canvas so clicks and context menus on cards work.
      if (e.button !== 0 || drag) return;
      if ((e.target as Element).closest('[data-map-node]')) return;
      drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, from: camRef.current, moved: false };
      surface.setPointerCapture(e.pointerId);
      surface.style.cursor = 'grabbing';
      surface.style.userSelect = 'none';
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < DRAG_SLOP) return;
        drag.moved = true;
        setInteracting(true);
      }
      userMove({ ...drag.from, x: drag.from.x + dx, y: drag.from.y + dy });
    };
    const endDrag = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (surface.hasPointerCapture(e.pointerId)) surface.releasePointerCapture(e.pointerId);
      if (drag.moved) setInteracting(false);
      drag = null;
      surface.style.cursor = '';
      surface.style.userSelect = '';
    };

    surface.addEventListener('wheel', onWheel, { passive: false });
    surface.addEventListener('gesturestart', onGestureStart);
    surface.addEventListener('gesturechange', onGestureChange);
    surface.addEventListener('gestureend', onGestureEnd);
    surface.addEventListener('pointerdown', onPointerDown);
    surface.addEventListener('pointermove', onPointerMove);
    surface.addEventListener('pointerup', endDrag);
    surface.addEventListener('pointercancel', endDrag);
    return () => {
      surface.removeEventListener('wheel', onWheel);
      surface.removeEventListener('gesturestart', onGestureStart);
      surface.removeEventListener('gesturechange', onGestureChange);
      surface.removeEventListener('gestureend', onGestureEnd);
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', endDrag);
      surface.removeEventListener('pointercancel', endDrag);
      surface.style.cursor = '';
      surface.style.userSelect = '';
    };
  }, [surface, setInteracting, touchInteraction, userMove]);

  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
  }, []);

  const bindWorld = useCallback((el: HTMLDivElement | null) => {
    worldRef.current = el;
    if (!el) return;
    el.style.transformOrigin = '0 0';
    el.style.transform = cameraTransform(camRef.current);
  }, []);

  const zoomByButton = useCallback((factor: number) => {
    const { width, height } = viewportRef.current;
    const base = tweenRef.current?.to ?? camRef.current;
    autoRef.current = false;
    animateTo(clampToContent(zoomAt(base, { x: width / 2, y: height / 2 }, factor)));
  }, [animateTo, clampToContent]);

  const goAuto = useCallback((animate: boolean) => {
    autoRef.current = true;
    const target = autoTargetRef.current;
    if (!target) { publish(); return; }
    if (animate) {
      animateTo(target);
    } else {
      tweenRef.current = null;
      camRef.current = target;
      write();
    }
  }, [animateTo, publish, write]);

  return useMemo<MapCameraController>(() => ({
    bindSurface: setSurface,
    bindWorld,
    subscribe: (listener) => {
      listenersRef.current.add(listener);
      return () => { listenersRef.current.delete(listener); };
    },
    getSnapshot: () => snapshotRef.current,
    zoomIn: () => zoomByButton(BUTTON_ZOOM_STEP),
    zoomOut: () => zoomByButton(1 / BUTTON_ZOOM_STEP),
    fit: () => goAuto(true),
    resetToAuto: () => goAuto(false),
  }), [bindWorld, goAuto, zoomByButton]);
}

/** Subscribe a component (the zoom pill) to camera scale/mode changes. */
export function useCameraSnapshot(camera: MapCameraController): CameraSnapshot {
  return useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot);
}
