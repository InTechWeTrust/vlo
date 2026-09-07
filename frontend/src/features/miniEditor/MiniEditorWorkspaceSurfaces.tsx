import { useLayoutEffect } from "react";
import { Box, Stack } from "@mui/material";
import { useShellLayoutStore } from "../../core/shell/layout/useShellLayoutStore";
import { dedicatedWorkspaceController } from "../../core/shell/workspaces";
import {
  MiniEditorActions,
  MiniEditorControls,
  MiniEditorPreview,
} from "./MiniEditorContent";
import { useMiniEditorStore } from "./useMiniEditorStore";

export function MiniEditorWorkspacePreviewSurface() {
  const title = useMiniEditorStore((state) => state.title);
  const previewMode = useMiniEditorStore((state) => state._internal.previewMode);
  const controlsCollapsed = useMiniEditorStore((state) => state.controlsCollapsed);
  useLayoutEffect(() => {
    // Workspace geometry is session-local and restored by the shell on exit.
    const layout = useShellLayoutStore.getState();
    if (previewMode && layout.activeWorkspaceLayout) {
      layout.setRegionCollapsed("lower-stage", controlsCollapsed);
    }
  }, [previewMode, controlsCollapsed]);
  return (
    <Box
      role="region"
      aria-label={title}
      sx={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        bgcolor: "#000",
      }}
    >
      <MiniEditorPreview fillStage />
      {previewMode ? (
        <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ p: 1 }}>
          <MiniEditorActions
            onRequestClose={() => void dedicatedWorkspaceController.exit()}
          />
        </Stack>
      ) : null}
    </Box>
  );
}

export function MiniEditorWorkspaceControlsSurface() {
  const previewMode = useMiniEditorStore((state) => state._internal.previewMode);
  const controlsCollapsed = useMiniEditorStore((state) => state.controlsCollapsed);
  if (controlsCollapsed) return null;
  return (
    <Stack
      spacing={1.5}
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: "auto",
        px: 2,
        py: 1.5,
        bgcolor: "#161618",
      }}
    >
      <MiniEditorControls />
      {previewMode ? null : (
        <Stack
          direction="row"
          justifyContent="flex-end"
          spacing={1}
          sx={{ mt: "auto" }}
        >
          <MiniEditorActions
            onRequestClose={() => void dedicatedWorkspaceController.exit()}
          />
        </Stack>
      )}
    </Stack>
  );
}
