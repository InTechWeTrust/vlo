import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Typography,
} from "@mui/material";
import {
  getComfyuiInstallStatus,
  getRuntimeSettings,
  installComfyui,
  pickComfyuiDirectory,
  updateRuntimeSettings,
  type ComfyuiInstallStatus,
} from "../../services/runtimeApi";

export function ComfyUiSetupPrompt() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installStatus, setInstallStatus] =
    useState<ComfyuiInstallStatus | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void getRuntimeSettings({ signal: controller.signal })
      .then((payload) => {
        if (payload.recommendations.shouldPromptForComfyuiInstallDir) {
          setOpen(true);
          void getComfyuiInstallStatus()
            .then((status) => {
              if (
                !controller.signal.aborted &&
                (status.running || status.phase === "failed")
              ) {
                setInstallStatus(status);
              }
            })
            .catch(() => {
              // The setup choices remain usable without progress recovery.
            });
        }
      })
      .catch(() => {
        // Startup remains usable when the optional local-runtime API is absent.
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!installStatus?.running) return;
    const interval = window.setInterval(() => {
      void getComfyuiInstallStatus()
        .then((status) => {
          setInstallStatus(status);
          if (status.phase === "complete") {
            setOpen(false);
          }
        })
        .catch((err: unknown) => {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to read ComfyUI installation progress",
          );
        });
    }, 1500);
    return () => window.clearInterval(interval);
  }, [installStatus?.running]);

  const handleChooseExisting = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await pickComfyuiDirectory("existing");
      if (result.cancelled || !result.path) return;
      if (!result.verification?.valid) {
        throw new Error(
          result.verification?.warnings[0] ??
            "The selected folder is not a recognized ComfyUI install",
        );
      }
      await updateRuntimeSettings({
        comfyuiInstallDir: result.verification.installPath,
        comfyuiInstallDirPromptStatus: "accepted",
      });
      setOpen(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to choose ComfyUI",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleInstall = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await pickComfyuiDirectory("install");
      if (result.cancelled || !result.path) return;
      const status = await installComfyui(result.path);
      setInstallStatus(status);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to start installation",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDecline = async () => {
    setOpen(false);
    setBusy(true);
    setError(null);
    try {
      await updateRuntimeSettings({
        comfyuiInstallDirPromptStatus: "declined",
      });
    } catch (err) {
      console.warn(
        "[ComfyUI setup] Failed to persist the generative AI opt-out:",
        err,
      );
    } finally {
      setBusy(false);
    }
  };

  const installing = installStatus?.running === true;

  return (
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
      <DialogTitle>Connect vlo to ComfyUI</DialogTitle>
      <DialogContent>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            vlo works without generative AI, but generation workflows use a
            local or remote ComfyUI instance. Choose an existing local install
            or let vlo install one.
          </Typography>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {installStatus ? (
            <Alert
              severity={installStatus.phase === "failed" ? "error" : "info"}
            >
              {installStatus.error ??
                installStatus.message ??
                "Preparing ComfyUI…"}
              {installStatus.targetPath ? (
                <Typography variant="caption" component="div">
                  {installStatus.targetPath}
                </Typography>
              ) : null}
            </Alert>
          ) : null}
          {installing ? <LinearProgress /> : null}
          {!installing ? (
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button
                variant="contained"
                onClick={() => void handleInstall()}
                disabled={busy}
              >
                Install ComfyUI For Me
              </Button>
              <Button
                variant="outlined"
                onClick={() => void handleChooseExisting()}
                disabled={busy}
              >
                Choose Existing Install
              </Button>
              {busy ? <CircularProgress size={24} /> : null}
            </Box>
          ) : null}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => void handleDecline()} disabled={busy || installing}>
          Continue without generative AI
        </Button>
      </DialogActions>
    </Dialog>
  );
}
