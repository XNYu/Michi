/** Keep horizontal reveal on the layout animation's eased clock. */
export function scrollWithPaneLayout(
  strip: HTMLElement,
  animation: Animation,
  target: number,
  onScroll: (left: number) => void,
) {
  const start = strip.scrollLeft;
  if (Math.abs(target - start) < 0.5) {
    onScroll(start);
    return () => {};
  }
  let frame = 0;
  let stopped = false;
  const write = (progress: number) => {
    strip.scrollLeft = start + (target - start) * progress;
    onScroll(strip.scrollLeft);
  };
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    animation.removeEventListener('finish', finish);
    animation.removeEventListener('cancel', stop);
    strip.removeEventListener('pointerdown', stop);
    strip.removeEventListener('wheel', stop);
    strip.removeEventListener('touchstart', stop);
  };
  const finish = () => {
    if (!stopped) write(1);
    stop();
  };
  const tick = () => {
    if (stopped) return;
    const progress = animation.effect?.getComputedTiming().progress;
    if (progress != null) write(progress);
    frame = requestAnimationFrame(tick);
  };
  animation.addEventListener('finish', finish);
  animation.addEventListener('cancel', stop);
  strip.addEventListener('pointerdown', stop, { passive: true });
  strip.addEventListener('wheel', stop, { passive: true });
  strip.addEventListener('touchstart', stop, { passive: true });
  frame = requestAnimationFrame(tick);
  return stop;
}
