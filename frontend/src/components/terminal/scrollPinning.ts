export interface FollowScrollInput {
  currentScrollTop: number;
  maxScroll: number;
  anchor: number;
  tail: number;
}

export function nextFollowScrollTop({
  currentScrollTop,
  maxScroll,
  anchor,
  tail,
}: FollowScrollInput): number {
  const target = Math.min(maxScroll, Math.max(anchor, tail));
  if (currentScrollTop > maxScroll) return maxScroll;
  if (target > currentScrollTop) return target;
  return currentScrollTop;
}
