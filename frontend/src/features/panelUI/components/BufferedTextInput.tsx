import { memo, useEffect, useRef, useState } from "react";
import {
  TextField,
  InputAdornment,
  type SxProps,
  type Theme,
} from "@mui/material";

interface BufferedFieldProps {
  label?: string;
  /** The parent's current value. Changes from upstream replace the draft. */
  value: string;
  onCommit: (val: string) => void;
  onPreview?: (val: string) => void;
  onEditEnd?: () => void;
  disabled?: boolean;
  placeholder?: string;
  multiline?: boolean;
  minRows?: number;
  maxRows?: number;
  endAdornment?: React.ReactNode;
  type?: React.InputHTMLAttributes<HTMLInputElement>["type"];
  inputProps?: Record<string, unknown>;
  /**
   * When set, typing commits on its own after this idle delay instead of
   * waiting for blur. Gated controls (e.g. a Generate button that reads the
   * committed value) would otherwise stay disabled while the user is still in
   * the field, with no blur to un-stick them — a disabled button never takes
   * focus, so clicking it does not commit either.
   */
  commitDebounceMs?: number;
  /**
   * After each commit attempt, replace the draft with whatever `value` the
   * parent renders next. The parent's answer is the only record of whether a
   * commit was accepted, normalized or refused, so this is how a field shows
   * the value that actually took instead of the text that was typed.
   *
   * Done in place rather than by remounting: a replaced input loses the
   * browser's focus-navigation position, so Enter then Tab would land back on
   * the field instead of the next control.
   */
  resetAfterCommit?: boolean;
  sx?: SxProps<Theme>;
}

function BufferedField({
  label,
  value,
  onCommit,
  onPreview,
  onEditEnd,
  disabled,
  placeholder,
  multiline,
  minRows,
  maxRows,
  endAdornment,
  type,
  inputProps,
  commitDebounceMs,
  resetAfterCommit = false,
  sx,
}: BufferedFieldProps) {
  const [localValue, setLocalValue] = useState<string>(value);
  const [resetRequest, setResetRequest] = useState(0);
  /**
   * The last draft handed to the parent, or the parent's value once that has
   * moved. Until the parent answers, a second blur on the same draft is not a
   * new edit and must not commit again.
   */
  const lastSubmittedValueRef = useRef(value);
  const localValueRef = useRef(value);
  const valuePropRef = useRef(value);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingCommit = () => {
    if (commitTimerRef.current !== null) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
  };

  const replaceDraft = (nextValue: string) => {
    localValueRef.current = nextValue;
    lastSubmittedValueRef.current = nextValue;
    setLocalValue(nextValue);
  };

  useEffect(() => {
    valuePropRef.current = value;
    // A debounced commit echoes back as a prop change. Resetting on that echo
    // would discard whatever the user typed while it was in flight, so only an
    // upstream value we did not just commit takes the field over.
    if (value === lastSubmittedValueRef.current) {
      return;
    }
    cancelPendingCommit();
    replaceDraft(value);
  }, [value]);

  // Declared after the sync above so `valuePropRef` already holds the value
  // the parent rendered in response to the commit.
  useEffect(() => {
    if (resetRequest === 0) return;
    replaceDraft(valuePropRef.current);
  }, [resetRequest]);

  useEffect(() => cancelPendingCommit, []);

  const commitValue = (nextValue: string) => {
    if (
      nextValue !== valuePropRef.current &&
      nextValue !== lastSubmittedValueRef.current
    ) {
      lastSubmittedValueRef.current = nextValue;
      onCommit(nextValue);
    }
    if (resetAfterCommit) {
      setResetRequest((request) => request + 1);
    }
  };

  const commit = () => {
    cancelPendingCommit();
    commitValue(localValueRef.current);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !multiline) {
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && multiline) {
      // Support Ctrl+Enter to commit for multiline
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <TextField
      label={label}
      variant="outlined"
      size="small"
      type={type}
      value={localValue}
      onChange={(e) => {
        const nextValue = e.target.value;
        setLocalValue(nextValue);
        localValueRef.current = nextValue;
        onPreview?.(nextValue);
        if (commitDebounceMs === undefined) {
          return;
        }
        cancelPendingCommit();
        commitTimerRef.current = setTimeout(() => {
          commitTimerRef.current = null;
          commitValue(localValueRef.current);
        }, commitDebounceMs);
      }}
      onBlur={() => {
        commit();
        onEditEnd?.();
      }}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      multiline={multiline}
      minRows={minRows}
      maxRows={maxRows}
      InputProps={{
        endAdornment: endAdornment ? (
          <InputAdornment position="end">{endAdornment}</InputAdornment>
        ) : null,
      }}
      inputProps={inputProps}
      sx={sx}
      fullWidth
      disabled={disabled}
    />
  );
}

export type BufferedTextInputProps = Omit<
  BufferedFieldProps,
  "resetAfterCommit" | "type"
>;

/**
 * Free text, buffered: commits on blur, Enter (Ctrl+Enter when multiline), or
 * an optional typing pause. The draft is kept after committing, since text is
 * taken as typed and a debounced commit must not disturb ongoing typing.
 */
function BufferedTextInputComponent(props: BufferedTextInputProps) {
  return <BufferedField {...props} />;
}

export type BufferedNumberInputProps = Omit<
  BufferedFieldProps,
  | "resetAfterCommit"
  | "type"
  | "commitDebounceMs"
  | "multiline"
  | "minRows"
  | "maxRows"
>;

/**
 * A number typed as text. Intermediate forms ("0.0", "-", ".") stay in the
 * field while editing; `onCommit` parses and validates on blur or Enter, and
 * the field then shows the parent's value — the accepted number, normalized,
 * or the previous one when the commit was refused.
 */
function BufferedNumberInputComponent(props: BufferedNumberInputProps) {
  return <BufferedField {...props} type="number" resetAfterCommit />;
}

export const BufferedTextInput = memo(BufferedTextInputComponent);
export const BufferedNumberInput = memo(BufferedNumberInputComponent);
