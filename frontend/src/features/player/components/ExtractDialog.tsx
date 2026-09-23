import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Stack,
  Typography,
  LinearProgress,
  Box,
  ButtonBase,
  Tooltip,
} from "@mui/material";
import CameraAltIcon from "@mui/icons-material/CameraAlt";
import ContentCutIcon from "@mui/icons-material/ContentCut";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import { CacheProvider, type EmotionCache } from "@emotion/react";
import createCache from "@emotion/cache";
import { useExtractStore, type DialogView } from "../../../core/extract/useExtractStore";
import type { ExportPhase } from "../../../core/export/exportProgress";
import { useProjectStore } from "../../project";
import {
  DEFAULT_PROJECT_OUTPUT_RESOLUTION,
  PROJECT_OUTPUT_RESOLUTIONS,
  isPresetProjectOutputResolution,
  normalizeProjectOutputResolution,
} from "../../project/outputResolutionOptions";
import { hostContextKeys } from "../../../core/shell/contextKeys";
import { hostOptionCatalog } from "../../../core/shell/optionCatalog";
import {
  DEFAULT_EXPORT_FORMAT_ID,
  EXPORT_FORMATS_CATALOGUE,
  declareExportFormats,
  readExportFormatValue,
  type ExportFormatValue,
} from "../exportFormatsCatalogue";

declareExportFormats();

/** Short edge, so one label reads correctly in both orientations. */
const RESOLUTION_LABELS: Readonly<Record<number, string>> = {
  480: "480p (SD)",
  720: "720p (HD)",
  1080: "1080p (FHD)",
  2160: "4K (UHD)",
};

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow: (options?: {
        width?: number;
        height?: number;
      }) => Promise<Window>;
    };
  }
}

interface PipState {
  win: Window;
  container: HTMLElement;
  cache: EmotionCache;
}

const EXPORT_PHASE_LABELS: Record<ExportPhase, string> = {
  preparing: "Preparing export…",
  audio: "Mixing audio…",
  rendering: "Rendering",
  finalizing: "Finishing video…",
  saving: "Saving file…",
  ingesting: "Adding to library…",
  cancelling: "Cancelling…",
};

interface ExportProgressProps {
  progress: number;
}

const STATIC_PROGRESS_SX = {
  "& .MuiLinearProgress-bar": { transition: "none", animation: "none" },
} as const;

function ExportProgress({ progress }: ExportProgressProps) {
  const phase = useExtractStore((state) => state.phase);
  const rendering = phase === null || phase === "rendering";
  return (
    <Box sx={{ width: "100%", mt: 2 }}>
      <Typography variant="body2" color="text.secondary" gutterBottom>
        {rendering ? `Rendering... ${Math.min(99, Math.round(progress))}%` : EXPORT_PHASE_LABELS[phase]}
      </Typography>
      {/* The rendering bar is static on purpose. MUI animates each update,
          and anything moving on screen competes with the export for the GPU:
          on vlo_03 the animated bar (here and in the progress PiP) more than
          doubled export time. The short phases without a percentage keep the
          indeterminate bar, which announces no value. */}
      <LinearProgress
        variant={rendering ? "determinate" : "indeterminate"}
        value={Math.min(99, progress)}
        sx={rendering ? STATIC_PROGRESS_SX : undefined}
      />
    </Box>
  );
}

function ExportProgressPip({ progress }: ExportProgressProps) {
  return (
    <Box sx={{ p: 2, color: "#eee", bgcolor: "#1a1a1a", minHeight: "100vh" }}>
      <ExportProgress progress={progress} />
      <Typography variant="body2">
        For very long exports, leave this popup open (but you can shrink and
        move it somewhere inoffensive).{" "}
        <Tooltip
          title="Browser limitations throttle background tabs and this could interrupt the file export. This popup keeps the export running smoothly."
          arrow
        >
          <Box
            component="span"
            sx={{
              textDecoration: "underline dotted",
              cursor: "help",
              fontWeight: 600,
            }}
          >
            why?
          </Box>
        </Tooltip>
      </Typography>
    </Box>
  );
}

interface ExtractDialogProps {
  open: boolean;
  dialogView: DialogView;
  onClose: () => void;
  onCancelProcessing?: () => void;
  onExtractFrame: () => void;
  onExtractSelection: () => void;
  onExport: (resolution: number, format: ExportFormatValue) => void;
  onSetView: (view: DialogView) => void;
  isProcessing: boolean;
  progress: number;
}

const optionButtonSx = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 1,
  p: 2.5,
  borderRadius: 2,
  bgcolor: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "#ccc",
  width: "100%",
  transition: "all 0.15s ease",
  "&:hover": {
    bgcolor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(255,255,255,0.25)",
    color: "#fff",
  },
} as const;

export function ExtractDialog({
  open,
  dialogView,
  onClose,
  onCancelProcessing,
  onExtractFrame,
  onExtractSelection,
  onExport,
  onSetView,
  isProcessing,
  progress,
}: ExtractDialogProps) {
  // The project resolution is the default; the dropdown is a per-export
  // override that lasts as long as the dialog is open.
  const projectResolution = useProjectStore(
    (state) => state.config.outputResolution ?? DEFAULT_PROJECT_OUTPUT_RESOLUTION,
  );
  const [resolution, setResolution] = useState(projectResolution);
  const [formatOptionId, setFormatOptionId] = useState(
    DEFAULT_EXPORT_FORMAT_ID,
  );
  const [pip, setPip] = useState<PipState | null>(null);
  const phase = useExtractStore((state) => state.phase);
  const error = useExtractStore((state) => state.error);
  const cannotCancel =
    phase === "saving" || phase === "ingesting" || phase === "cancelling";
  const handleCancelProcessing = onCancelProcessing ?? onClose;

  useSyncExternalStore(
    (listener) => hostOptionCatalog.subscribe(listener),
    () => hostOptionCatalog.getRevision(),
    () => hostOptionCatalog.getRevision(),
  );
  useSyncExternalStore(
    (listener) => hostContextKeys.subscribe(listener),
    () => hostContextKeys.getRevision(),
    () => hostContextKeys.getRevision(),
  );
  const formatOptions = hostOptionCatalog.resolveOptions(
    EXPORT_FORMATS_CATALOGUE,
  );
  const selectedFormat = readExportFormatValue(
    formatOptions.find((option) => option.id === formatOptionId),
  );

  const exportInProgress = isProcessing && dialogView === "export";

  // Seed on the open transition only — not on every project change — so an
  // override the user picked is not yanked out from under them mid-dialog.
  // Adjusted during render rather than in an effect: the dialog must never
  // paint one resolution and then correct itself.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setResolution(projectResolution);
    }
  }

  useEffect(() => {
    if (!exportInProgress) return;
    const dpip = window.documentPictureInPicture;
    if (!dpip) return;

    let cancelled = false;
    let openedWindow: Window | null = null;

    (async () => {
      try {
        const win = await dpip.requestWindow({ width: 380, height: 200 });
        if (cancelled) {
          win.close();
          return;
        }
        openedWindow = win;
        win.document.title = "Exporting…";

        for (const node of Array.from(
          document.head.querySelectorAll("style, link[rel='stylesheet']"),
        )) {
          win.document.head.appendChild(node.cloneNode(true));
        }

        win.document.body.style.margin = "0";
        win.document.body.style.backgroundColor = "#1a1a1a";

        const container = win.document.createElement("div");
        win.document.body.appendChild(container);

        const cache = createCache({
          key: "pip",
          container: win.document.head,
        });

        win.addEventListener("pagehide", () => {
          setPip((current) => (current?.win === win ? null : current));
        });

        setPip({ win, container, cache });
      } catch (err) {
        console.error("Failed to open Document Picture-in-Picture", err);
      }
    })();

    return () => {
      cancelled = true;
      if (openedWindow) openedWindow.close();
      setPip(null);
    };
  }, [exportInProgress]);

  if (error) {
    return (
      <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
        <DialogTitle>Export failed</DialogTitle>
        <DialogContent><Typography role="alert">{error}</Typography></DialogContent>
        <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
      </Dialog>
    );
  }

  if (dialogView === "choose") {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth="xs"
        fullWidth
        PaperProps={{ sx: { bgcolor: "#1a1a1a", color: "#eee" } }}
      >
        <DialogTitle>Extract</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <ButtonBase sx={optionButtonSx} onClick={onExtractFrame}>
              <CameraAltIcon fontSize="medium" />
              <Typography variant="body2" fontWeight={600}>
                Extract Frame
              </Typography>
              <Typography variant="caption" sx={{ color: "#888" }}>
                Save a single frame as an image asset
              </Typography>
            </ButtonBase>

            <ButtonBase sx={optionButtonSx} onClick={onExtractSelection}>
              <ContentCutIcon fontSize="medium" />
              <Typography variant="body2" fontWeight={600}>
                Extract Selection
              </Typography>
              <Typography variant="caption" sx={{ color: "#888" }}>
                Select a range on the timeline to extract as video
              </Typography>
            </ButtonBase>

            <ButtonBase sx={optionButtonSx} onClick={() => onSetView("export")}>
              <FileDownloadIcon fontSize="medium" />
              <Typography variant="body2" fontWeight={600}>
                Export
              </Typography>
              <Typography variant="caption" sx={{ color: "#888" }}>
                Download the full timeline as MP4
              </Typography>
            </ButtonBase>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} color="inherit" size="small">
            Cancel
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  if (dialogView === "export") {
    return (
      <>
        <Dialog
          open={open}
          onClose={isProcessing ? undefined : onClose}
          maxWidth="xs"
          fullWidth
          PaperProps={{ sx: { bgcolor: "#1a1a1a", color: "#eee" } }}
        >
          <DialogTitle>Export Project</DialogTitle>
          <DialogContent>
            <Stack spacing={3} sx={{ mt: 1 }}>
              {!isProcessing ? (
                <>
                  <FormControl fullWidth size="small">
                    <InputLabel id="export-format-label">Format</InputLabel>
                    <Select
                      labelId="export-format-label"
                      value={formatOptionId}
                      label="Format"
                      onChange={(event) =>
                        setFormatOptionId(event.target.value)
                      }
                    >
                      {!selectedFormat ? (
                        <MenuItem value={formatOptionId} disabled>
                          Missing format provider
                        </MenuItem>
                      ) : null}
                      {formatOptions.map((option) => (
                        <MenuItem key={option.id} value={option.id}>
                          {option.label}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <FormControl fullWidth size="small">
                    <InputLabel id="export-resolution-label">
                      Resolution
                    </InputLabel>
                    <Select
                      labelId="export-resolution-label"
                      value={resolution}
                      label="Resolution"
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        const normalized =
                          normalizeProjectOutputResolution(next);
                        if (normalized !== null) setResolution(normalized);
                      }}
                    >
                      {!isPresetProjectOutputResolution(projectResolution) ? (
                        <MenuItem value={projectResolution}>
                          {projectResolution}px (Project)
                        </MenuItem>
                      ) : null}
                      {PROJECT_OUTPUT_RESOLUTIONS.map((option) => (
                        <MenuItem key={option} value={option}>
                          {RESOLUTION_LABELS[option] ?? `${option}p`}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </>
              ) : (
                <ExportProgress progress={progress} />
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            {!isProcessing ? (
              <>
                <Button
                  onClick={() => onSetView("choose")}
                  color="inherit"
                  size="small"
                >
                  Back
                </Button>
                <Button
                  onClick={() => {
                    if (selectedFormat) onExport(resolution, selectedFormat);
                  }}
                  disabled={!selectedFormat}
                  variant="contained"
                  color="primary"
                  size="small"
                >
                  Export
                </Button>
              </>
            ) : (
              <Button onClick={handleCancelProcessing} disabled={cannotCancel} color="error" size="small">
                Cancel
              </Button>
            )}
          </DialogActions>
        </Dialog>
        {pip &&
          createPortal(
            <CacheProvider value={pip.cache}>
              <ExportProgressPip progress={progress} />
            </CacheProvider>,
            pip.container,
          )}
      </>
    );
  }

  if (dialogView === "extracting-frame") {
    return (
      <Dialog
        open={open}
        maxWidth="xs"
        fullWidth
        PaperProps={{ sx: { bgcolor: "#1a1a1a", color: "#eee" } }}
      >
        <DialogContent>
          <Stack spacing={2} alignItems="center" sx={{ py: 2 }}>
            <Typography variant="body1">Extracting frame...</Typography>
          </Stack>
        </DialogContent>
      </Dialog>
    );
  }

  // extracting-selection
  return (
    <Dialog
      open={open}
      maxWidth="xs"
      fullWidth
      PaperProps={{ sx: { bgcolor: "#1a1a1a", color: "#eee" } }}
    >
      <DialogTitle>Extracting Selection</DialogTitle>
      <DialogContent>
        <ExportProgress progress={progress} />
      </DialogContent>
      <DialogActions>
        <Button onClick={handleCancelProcessing} disabled={cannotCancel} color="error" size="small">
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}
