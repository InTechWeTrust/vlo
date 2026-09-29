import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ControlRenderer } from "../ControlRenderer";
import { liveParamStore } from "../../../../core/liveParams/liveParamStore";
import type { ControlDefinition } from "../../../panelUI/types";

// Keyframed 1 → 2 across the clip; the clip-start value (1) is what React
// holds, while the renderer has resolved 1.5 at the playhead.
const ANIMATED_SCALE = {
  type: "spline",
  points: [
    { time: 0, value: 1 },
    { time: 100, value: 2 },
  ],
};

function renderScalar(transformId: string, onCommit = vi.fn()) {
  const control: ControlDefinition = {
    type: "number",
    name: "x",
    label: "Scale X",
    supportsSpline: true,
  };
  const view = render(
    <ControlRenderer
      control={control}
      value={ANIMATED_SCALE}
      onCommit={onCommit}
      groupId="scale"
      transformId={transformId}
      minTime={0}
      duration={100}
    />,
  );
  const rerender = () =>
    view.rerender(
      <ControlRenderer
        control={{ ...control }}
        value={ANIMATED_SCALE}
        onCommit={onCommit}
        groupId="scale"
        transformId={transformId}
        minTime={0}
        duration={100}
      />,
    );
  return { input: screen.getByLabelText("Scale X"), rerender, onCommit };
}

describe("ControlRenderer live values", () => {
  it("shows the playhead value when a control mounts after the render", () => {
    liveParamStore.notify("scale-mount", "x", 1.5);

    const { input } = renderScalar("scale-mount");

    expect(input).toHaveValue(1.5);
  });

  it("keeps the playhead value when the control re-renders", () => {
    liveParamStore.notify("scale-rerender", "x", 1.5);
    const { input, rerender } = renderScalar("scale-rerender");

    // e.g. a tab press re-rendering the panel before the tab switches.
    rerender();

    expect(input).toHaveValue(1.5);
  });

  it("edits from the playhead value and commits nothing when left untouched", () => {
    liveParamStore.notify("scale-focus", "x", 1.5);
    const { input, onCommit } = renderScalar("scale-focus");

    fireEvent.focus(input);
    expect(input).toHaveValue(1.5);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "1.75" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(1.75);
  });
});
