/**
 * Below this CSS width the torus sits behind the hero headline and reduces
 * contrast on the text it overlaps. The shader backdrop stays; only the ring
 * is dropped. The threshold covers 320px and 375px phones, and the narrow
 * tablet layouts where the headline still reaches the ring's left edge.
 */
export const CHROME_RING_MIN_VIEWPORT_WIDTH = 640;

export function shouldRenderChromeRing(viewportWidth: number): boolean {
  return viewportWidth >= CHROME_RING_MIN_VIEWPORT_WIDTH;
}
