import { useState, type FormEvent } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from "@mui/material";
import {
  MAX_PROJECT_OUTPUT_RESOLUTION,
  MIN_PROJECT_OUTPUT_RESOLUTION,
  normalizeProjectOutputResolution,
} from "../outputResolutionOptions";
import type { AspectRatio } from "../aspectRatioOptions";
import { getProjectOutputGeometryError } from "../projectOutputGeometry";

interface CustomOutputResolutionDialogProps {
  value: number;
  aspectRatio: AspectRatio;
  onClose: () => void;
  onApply: (resolution: number) => void;
}

export function CustomOutputResolutionDialog({
  value,
  aspectRatio,
  onClose,
  onApply,
}: CustomOutputResolutionDialogProps) {
  const [shortEdge, setShortEdge] = useState(String(value));
  const resolution = normalizeProjectOutputResolution(Number(shortEdge));
  const error = getProjectOutputGeometryError(aspectRatio, resolution);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (resolution !== null && !error) onApply(resolution);
  }

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Custom output resolution</DialogTitle>
      <Box component="form" onSubmit={handleSubmit}>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Short edge"
            size="small"
            value={shortEdge}
            onChange={(event) =>
              setShortEdge(event.target.value.replace(/\D/g, ""))
            }
            inputProps={{ inputMode: "numeric" }}
            sx={{ mt: 1 }}
          />
          <Typography variant="caption" color="text.secondary">
            Even whole pixels from {MIN_PROJECT_OUTPUT_RESOLUTION} to{" "}
            {MAX_PROJECT_OUTPUT_RESOLUTION}. The other edge follows the project
            aspect ratio.
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
