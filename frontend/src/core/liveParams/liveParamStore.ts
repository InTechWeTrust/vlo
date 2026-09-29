type ParamListener = (value: number) => void;

/**
 * A near-zero-overhead pub/sub store for live-resolved transformation parameter values.
 *
 * Written to by `applyClipTransforms` on every render frame.
 * Read by UI controls (SliderControl, ScalarControl) via direct DOM ref updates,
 * completely bypassing the React render cycle.
 *
 * The last notified value per parameter is retained and replayed to new
 * subscribers. Controls mount with the value at the clip's start, and a paused
 * renderer has no reason to notify again, so without the replay a control
 * remounted mid-clip (e.g. switching panel tabs) would show the wrong value
 * until the next scrub.
 */
class LiveParamStore {
  private readonly listeners = new Map<string, Set<ParamListener>>();
  private readonly lastValues = new Map<string, number>();

  /**
   * Called by applyClipTransforms each frame with the resolved numeric value
   * of a parameter at the current playhead time.
   */
  notify(transformId: string, paramName: string, value: number): void {
    const key = `${transformId}:${paramName}`;
    this.lastValues.set(key, value);
    const subs = this.listeners.get(key);
    if (!subs || subs.size === 0) return;
    for (const fn of subs) fn(value);
  }

  /** The last notified value for a parameter, if it has been rendered. */
  peek(transformId: string, paramName: string): number | undefined {
    return this.lastValues.get(`${transformId}:${paramName}`);
  }

  /**
   * Subscribe to live resolved values for a specific transform parameter.
   * The callback receives the resolved numeric value each frame, and is called
   * immediately with the last notified value if one exists.
   * Returns an unsubscribe function.
   */
  subscribe(transformId: string, paramName: string, fn: ParamListener): () => void {
    const key = `${transformId}:${paramName}`;
    let subs = this.listeners.get(key);
    if (!subs) {
      subs = new Set();
      this.listeners.set(key, subs);
    }
    subs.add(fn);
    const lastValue = this.lastValues.get(key);
    if (lastValue !== undefined) fn(lastValue);
    return () => {
      const s = this.listeners.get(key);
      if (s) {
        s.delete(fn);
        if (s.size === 0) this.listeners.delete(key);
      }
    };
  }
}

export const liveParamStore = new LiveParamStore();
