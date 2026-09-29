import { describe, expect, it, vi } from "vitest";
import { liveParamStore } from "../liveParamStore";

describe("liveParamStore", () => {
  it("delivers notified values to subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = liveParamStore.subscribe("scale-a", "x", listener);

    liveParamStore.notify("scale-a", "x", 1.5);

    expect(listener).toHaveBeenCalledWith(1.5);
    unsubscribe();
  });

  it("replays the last notified value to a control that mounts later", () => {
    // Renderer resolved a keyframed value while no panel was subscribed
    // (e.g. the adjust tab was closed).
    liveParamStore.notify("scale-b", "x", 1.2);
    liveParamStore.notify("scale-b", "x", 1.8);

    const listener = vi.fn();
    const unsubscribe = liveParamStore.subscribe("scale-b", "x", listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(1.8);
    unsubscribe();
  });

  it("does not call a new subscriber when nothing has been notified", () => {
    const listener = vi.fn();
    const unsubscribe = liveParamStore.subscribe("scale-c", "x", listener);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("keeps replay values scoped to their parameter", () => {
    liveParamStore.notify("scale-d", "x", 2);

    const listener = vi.fn();
    const unsubscribe = liveParamStore.subscribe("scale-d", "y", listener);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
