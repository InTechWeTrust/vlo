import { memo, useRef, type ReactNode } from "react";
import type { SliderProps } from "@mui/material";
import { BufferedInput } from "./BufferedInput";
import {
  SliderFrame,
  SliderReadoutInput,
  SliderReadoutText,
  SliderTrack,
} from "./SliderFrame";
import {
  constrainRangeEnd,
  normalizeRange,
  type RangeEnd,
  type RangeEndLimits,
  type RangeValue,
} from "./rangeSliderConstraints";

export interface RangeSliderControlProps {
  label: string;
  value: RangeValue;
  min: number;
  max: number;
  step: number;
  /** Smallest allowed `high - low`; 0 (the default) lets the range collapse. */
  minDistance?: number;
  /** Tighter bounds for the low end, inside `min`/`max`. */
  lowLimits?: RangeEndLimits;
  /** Tighter bounds for the high end, inside `min`/`max`. */
  highLimits?: RangeEndLimits;
  /** Accessible names for the two thumbs (and typed fields). */
  endLabels?: readonly [low: string, high: string];
  /** Every constrained move, naming the end that moved. */
  onChange: (value: [number, number], end: RangeEnd) => void;
  /** The settled range once a drag or keyboard step ends. */
  onChangeCommitted?: (value: [number, number]) => void;
  /**
   * Typed-value commits. Supplying it gives the header a field per end;
   * without it the header shows `formatReadout` (or `formatValue` per end).
   */
  onInputCommit?: (value: [number, number], end: RangeEnd) => void;
  formatValue?: (value: number) => string;
  /** Replaces the whole header readout, e.g. to name a collapsed range. */
  formatReadout?: (value: RangeValue) => ReactNode;
  endAdornment?: ReactNode;
  marks?: SliderProps["marks"];
  disabled?: boolean;
}

const RANGE_SEPARATOR = "–";

function RangeSliderControlComponent({
  label,
  value,
  min,
  max,
  step,
  minDistance = 0,
  lowLimits,
  highLimits,
  endLabels,
  onChange,
  onChangeCommitted,
  onInputCommit,
  formatValue,
  formatReadout,
  endAdornment,
  marks,
  disabled,
}: RangeSliderControlProps) {
  const constraints = {
    min,
    max,
    minDistance,
    low: lowLimits,
    high: highLimits,
  };
  const range = normalizeRange(value, constraints);
  // MUI's commit callback carries the raw thumb values, not the constrained
  // ones, so the last constrained move is what gets committed.
  const lastMoveRef = useRef<[number, number] | null>(null);
  const [lowLabel, highLabel] = endLabels ?? [
    `${label} start`,
    `${label} end`,
  ];
  const format = formatValue ?? String;

  const move = (end: RangeEnd, next: number): [number, number] =>
    constrainRangeEnd(range, end, next, constraints);

  const readout = (
    <>
      {onInputCommit ? (
        <>
          <SliderReadoutInput>
            <BufferedInput
              label=""
              ariaLabel={lowLabel}
              value={range[0]}
              step={step}
              variant="clean"
              disabled={disabled}
              onCommit={(next) => onInputCommit(move("low", next), "low")}
            />
          </SliderReadoutInput>
          <SliderReadoutText>{RANGE_SEPARATOR}</SliderReadoutText>
          <SliderReadoutInput>
            <BufferedInput
              label=""
              ariaLabel={highLabel}
              value={range[1]}
              step={step}
              variant="clean"
              disabled={disabled}
              onCommit={(next) => onInputCommit(move("high", next), "high")}
            />
          </SliderReadoutInput>
        </>
      ) : (
        <SliderReadoutText>
          {formatReadout
            ? formatReadout(range)
            : `${format(range[0])} ${RANGE_SEPARATOR} ${format(range[1])}`}
        </SliderReadoutText>
      )}
      {endAdornment}
    </>
  );

  return (
    <SliderFrame label={label} readout={readout}>
      <SliderTrack
        value={range}
        min={min}
        max={max}
        step={step}
        marks={marks}
        disableSwap
        getAriaLabel={(index) => (index === 0 ? lowLabel : highLabel)}
        getAriaValueText={(thumbValue) => format(thumbValue)}
        onChange={(_event, next, activeThumb) => {
          if (!Array.isArray(next)) return;
          const end: RangeEnd = activeThumb === 0 ? "low" : "high";
          const constrained = move(end, next[activeThumb]);
          lastMoveRef.current = constrained;
          if (constrained[0] === range[0] && constrained[1] === range[1]) {
            return;
          }
          onChange(constrained, end);
        }}
        {...(onChangeCommitted
          ? {
              onChangeCommitted: () => {
                onChangeCommitted(lastMoveRef.current ?? range);
                lastMoveRef.current = null;
              },
            }
          : {})}
        size="small"
        disabled={disabled}
      />
    </SliderFrame>
  );
}

export const RangeSliderControl = memo(RangeSliderControlComponent);
