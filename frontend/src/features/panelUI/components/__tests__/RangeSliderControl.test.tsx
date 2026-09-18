import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RangeSliderControl } from "../RangeSliderControl";

function renderRange(
  overrides: Partial<Parameters<typeof RangeSliderControl>[0]> = {},
) {
  const onChange = vi.fn();
  const onInputCommit = vi.fn();
  render(
    <RangeSliderControl
      label="Motion hold"
      value={[1, 4]}
      min={0}
      max={20}
      step={1}
      lowLimits={{ max: 19 }}
      endLabels={["Lock-in", "Release"]}
      onChange={onChange}
      {...overrides}
    />,
  );
  return { onChange, onInputCommit };
}

describe("RangeSliderControl", () => {
  it("names each thumb and exposes the ends' values", () => {
    renderRange();
    const low = screen.getByRole("slider", { name: "Lock-in" });
    const high = screen.getByRole("slider", { name: "Release" });

    expect(low).toHaveAttribute("aria-valuenow", "1");
    expect(high).toHaveAttribute("aria-valuenow", "4");
    expect(screen.getByText("1 – 4")).toBeInTheDocument();
  });

  it("moves one end through the keyboard and reports which", () => {
    const { onChange } = renderRange();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Release" }), {
      key: "ArrowRight",
    });

    expect(onChange).toHaveBeenCalledWith([1, 5], "high");
  });

  it("does not let the low end pass the high end", () => {
    const { onChange } = renderRange({ value: [4, 4] });
    fireEvent.keyDown(screen.getByRole("slider", { name: "Lock-in" }), {
      key: "ArrowRight",
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders an out-of-order pair collapsed and lets the readout name it", () => {
    renderRange({
      value: [6, 3],
      formatReadout: ([low, high]) =>
        high <= low ? `${low} · seed only` : `${low} – ${high}`,
    });

    expect(
      screen.getByRole("slider", { name: "Release" }),
    ).toHaveAttribute("aria-valuenow", "6");
    expect(screen.getByText("6 · seed only")).toBeInTheDocument();
  });

  it("constrains typed values before committing them", () => {
    const onInputCommit = vi.fn();
    renderRange({ onInputCommit });
    const low = screen.getByRole("spinbutton", { name: "Lock-in" });

    fireEvent.change(low, { target: { value: "12" } });
    fireEvent.blur(low);

    expect(onInputCommit).toHaveBeenCalledWith([4, 4], "low");
  });
});
