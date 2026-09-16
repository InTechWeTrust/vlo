import { useState, type FormEvent } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  MAX_ASPECT_RATIO_PART,
  normalizeAspectRatio,
  type AspectRatio,
} from "../aspectRatioOptions";
import { getProjectOutputGeometryError } from "../projectOutputGeometry";

interface CustomAspectRatioDialogProps {
  value: AspectRatio;
  outputResolution: number;
  onClose: () => void;
  onApply: (aspectRatio: AspectRatio) => void;
}

export function CustomAspectRatioDialog({
  value,
  outputResolution,
  onClose,
  onApply,
}: CustomAspectRatioDialogProps) {
  const [initialWidth, initialHeight] = value.split(":");
  const [widthPart, setWidthPart] = useState(initialWidth ?? "");
  const [heightPart, setHeightPart] = useState(initialHeight ?? "");
  const normalized = normalizeAspectRatio(`${widthPart}:${heightPart}`);
  const error = getProjectOutputGeometryError(normalized, outputResolution);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (normalized && !error) onApply(normalized);
  }

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Custom aspect ratio</DialogTitle>
      <Box component="form" onSubmit={handleSubmit}>
        <DialogContent>
          <Stack
            direction="row"
            spacing={1.5}
            alignItems="center"
            sx={{ mt: 1 }}
          >
            <TextField
              autoFocus
              label="Width"
              size="small"
              value={widthPart}
              onChange={(event) =>
                setWidthPart(event.target.value.replace(/\D/g, ""))
              }
              inputProps={{ inputMode: "numeric" }}
              fullWidth
            />
            <Typography color="text.secondary">:</Typography>
            <TextField
              label="Height"
              size="small"
              value={heightPart}
              onChange={(event) =>
                setHeightPart(event.target.value.replace(/\D/g, ""))
              }
              inputProps={{ inputMode: "numeric" }}
              fullWidth
            />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Each part must be a whole number from 1 to {MAX_ASPECT_RATIO_PART}.
            Ratios from 1:4 to 4:1 are supported and equivalent ratios are
            reduced automatically.
          </Typography>
          {error ? (
            <Alert severity="error" sx={{ mt: 1 }}>
              {error}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={Boolean(error)}>
            Apply
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
