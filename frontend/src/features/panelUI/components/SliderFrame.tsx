import type { ReactNode } from "react";
import { Slider } from "@mui/material";
import { styled } from "@mui/material/styles";

/**
 * The layout every panel slider shares: a label and a readout on one line,
 * the track underneath. Single and range sliders are both this frame with a
 * different readout and track, and a bespoke track (a gradient bar, a curve
 * handle) can sit in it too and still line up with the stock ones.
 */
export interface SliderFrameProps {
  label: string;
  /** Right-hand side of the header: typed inputs, a formatted value, or both. */
  readout?: ReactNode;
  children: ReactNode;
}

const Root = styled("div")({
  display: "flex",
  flexDirection: "column",
  boxSizing: "border-box",
  minWidth: 0,
  maxWidth: "100%",
  width: "100%",
  paddingLeft: 8,
  paddingRight: 8,
});

const Header = styled("div")({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  minWidth: 0,
  gap: 4,
  marginBottom: 4,
});

const Label = styled("div")(({ theme }) => ({
  ...theme.typography.caption,
  color: theme.palette.text.secondary,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
}));

const Readout = styled("div")({
  display: "flex",
  alignItems: "center",
  flexShrink: 0,
  gap: 4,
});

/** A formatted, non-editable value for the header. */
export const SliderReadoutText = styled("div")(({ theme }) => ({
  ...theme.typography.caption,
  color: theme.palette.text.secondary,
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
}));

/** A typed-value field for the header, sized for a handful of digits. */
export const SliderReadoutInput = styled("div")({
  width: 60,
});

/** The stock MUI track, with the frame's vertical rhythm. */
export const SliderTrack = styled(Slider)({
  paddingTop: 4,
  paddingBottom: 4,
});

export function SliderFrame({ label, readout, children }: SliderFrameProps) {
  return (
    <Root>
      <Header>
        <Label>{label}</Label>
        {readout !== undefined && readout !== null ? (
          <Readout>{readout}</Readout>
        ) : null}
      </Header>
      {children}
    </Root>
  );
}
