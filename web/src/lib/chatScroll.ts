/** Chat scroll & lazy-render window helpers (chat-ux-improvements FR-1/FR-2).
 *
 * Pure and property-tested: the transcript mounts only its newest `visible`
 * items (the window is anchored to the end); scrolling up grows the window
 * chunk by chunk. `isPinned` is the single bottom-stick predicate driving
 * auto-scroll, the new-messages badge, and end-of-turn focus return.
 */

/** Distance (px) from the content bottom within which the view counts as pinned. */
export const PIN_THRESHOLD_PX = 64
/** Transcript items mounted right after a hydration reset. */
export const INITIAL_WINDOW = 40
/** Items added per grow step (top-sentinel intersection). */
export const WINDOW_CHUNK = 40

/** True when the viewport bottom is within `threshold` px of the content end. */
export function isPinned(
  distanceFromBottom: number,
  threshold: number = PIN_THRESHOLD_PX,
): boolean {
  return distanceFromBottom <= threshold
}

/** Window size after one grow step — monotonic, clamped to `total`. */
export function growWindow(visible: number, total: number, chunk: number = WINDOW_CHUNK): number {
  return Math.min(Math.max(total, 0), Math.max(visible, 0) + Math.max(chunk, 0))
}

/** Absolute transcript index of the first mounted item (stable render keys). */
export function windowStart(total: number, visible: number): number {
  return Math.max(0, Math.max(total, 0) - Math.max(visible, 0))
}
