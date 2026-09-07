type ScrollTimelineConstructor = new (options: {
  source: HTMLElement;
  axis: 'x';
}) => AnimationTimeline;

/** The dashboard owns scrolling; captions are a non-scrolling projection. */
export function bindPaneCaptionScroll(strip: HTMLElement, captions: HTMLElement, moving = false) {
  const viewport = captions.parentElement!;
  const Timeline = (window as Window & { ScrollTimeline?: ScrollTimelineConstructor }).ScrollTimeline;
  let animation: Animation | undefined;
  let range = -1;

  const mirror = () => {
    captions.style.transform = `translateX(${-strip.scrollLeft}px)`;
  };
  const updateRange = () => {
    const next = Math.max(0, strip.scrollWidth - strip.clientWidth);
    if (next === range) return;
    range = next;
    mirror();
    if (moving || !Timeline || typeof captions.animate !== 'function') return;
    const frames = [{ transform: 'translateX(0px)' }, { transform: `translateX(${-range}px)` }];
    if (animation) {
      (animation.effect as KeyframeEffect).setKeyframes(frames);
    } else {
      // A native scroll timeline follows compositor scrolling without waiting
      // for a main-thread scroll event (including trackpad momentum).
      animation = captions.animate(frames, {
        timeline: new Timeline({ source: strip, axis: 'x' }),
        fill: 'both',
        easing: 'linear',
      });
    }
  };
  const onScroll = () => {
    // Native timelines need no main-thread style writes while scrolling.
    if (!animation) mirror();
  };
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) return;
    const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
    if (!delta) return;
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? strip.clientWidth : 1;
    strip.scrollBy({ left: delta * unit, behavior: 'instant' });
  };

  // Track animated grid widths as well as viewport resizes. Observe only the
  // pane wrappers, never transcript mutations on the streaming hot path.
  const observer = new ResizeObserver(updateRange);
  observer.observe(strip);
  for (const pane of strip.children) {
    if (pane.hasAttribute('data-node-id')) observer.observe(pane);
  }
  strip.addEventListener('scroll', onScroll, { passive: true });
  viewport.addEventListener('wheel', onWheel, { passive: false });
  updateRange();
  return () => {
    observer.disconnect();
    animation?.cancel();
    strip.removeEventListener('scroll', onScroll);
    viewport.removeEventListener('wheel', onWheel);
    captions.style.removeProperty('transform');
  };
}
