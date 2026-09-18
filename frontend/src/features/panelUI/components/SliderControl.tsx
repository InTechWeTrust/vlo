import { memo } from "react";
import type { SliderProps } from "@mui/material";
import { BufferedInput } from "./BufferedInput";
import {
  SliderFrame,
  SliderReadoutInput,
  SliderReadoutText,
  SliderTrack,
} from "./SliderFrame";

export interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (event: Event, value: number | number[]) => void;
  onChangeCommitted?: (
    event: Event | React.SyntheticEvent | unknown,
    value: number | number[],
  ) => void;
  /**
   * Typed-value commits. Supplying it gives the header an editable field;
   * without it the header shows `formatValue(value)` as text instead.
   */
  onInputCommit?: (value: number) => void;
  /** Header text when there is no typed field. Defaults to `String(value)`. */
  formatValue?: (value: number) => string;
  endAdornment?: React.ReactNode;
  inputRef?: React.Ref<HTMLInputElement>;
  sliderRef?: React.Ref<HTMLSpanElement>;
  onMouseDown?: React.MouseEventHandler<HTMLSpanElement>;
  onMouseUp?: React.MouseEventHandler<HTMLSpanElement>;
  marks?: SliderProps["marks"];
  disabled?: boolean;
}

function SliderControlComponent({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onChangeCommitted,
  onInputCommit,
  formatValue,
  endAdornment,
  inputRef,
  sliderRef,
  onMouseDown,
  onMouseUp,
  marks,
  disabled,
}: SliderControlProps) {
  const readout = (
    <>
      {onInputCommit ? (
        <SliderReadoutInput>
          <BufferedInput
            ref={inputRef}
            label=""
            ariaLabel={label}
            value={value}
            onCommit={onInputCommit}
            step={step}
            variant="clean"
            disabled={disabled}
          />
        </SliderReadoutInput>
      ) : (
        <SliderReadoutText>
          {formatValue ? formatValue(value) : String(value)}
        </SliderReadoutText>
      )}
      {endAdornment}
    </>
  );

  return (
    <SliderFrame label={label} readout={readout}>
      <SliderTrack
        ref={sliderRef}
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        marks={marks}
        onChange={onChange}
        {...(onChangeCommitted ? { onChangeCommitted } : {})}
        // Never forward these as explicit `undefined`: MUI's mergeSlotProps
        // spreads non-function `on*` props over the slider's own composed
        // handlers, so `onMouseDown={undefined}` erases MUI's internal
        // mousedown handler and leaves the slider mouse-dead.
        {...(onMouseDown ? { onMouseDown } : {})}
        {...(onMouseUp ? { onMouseUp } : {})}
        size="small"
        disabled={disabled}
      />
    </SliderFrame>
  );
}

export const SliderControl = memo(SliderControlComponent);
