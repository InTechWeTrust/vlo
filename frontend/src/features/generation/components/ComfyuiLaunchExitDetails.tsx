import { Box, Typography } from "@mui/material";
import type { ComfyUiLaunchStatus } from "../../../types/RuntimeStatus";

interface ComfyuiLaunchExitDetailsProps {
  launch: ComfyUiLaunchStatus;
}

export function ComfyuiLaunchExitDetails({
  launch,
}: ComfyuiLaunchExitDetailsProps) {
  return (
    <Box sx={{ mt: 1 }}>
      <Typography
        variant="caption"
        sx={{ color: "error.main", display: "block" }}
      >
        ComfyUI stopped
        {launch.exitCode !== null ? ` (exit code ${launch.exitCode})` : ""}.
        {launch.logTail.length > 0 ? " Last output:" : ""}
      </Typography>
      {launch.logTail.length > 0 ? (
        <Box
          component="pre"
          data-testid="comfyui-launch-log-tail"
          sx={{
            mt: 0.5,
            mb: 0,
            p: 1,
            maxHeight: 180,
            overflow: "auto",
            fontFamily: "monospace",
            fontSize: 11,
            lineHeight: 1.4,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            bgcolor: "action.hover",
            borderRadius: 0.5,
          }}
        >
          {launch.logTail.join("\n")}
        </Box>
      ) : null}
      {launch.logPath ? (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            display: "block",
            mt: 0.5,
            wordBreak: "break-all",
          }}
        >
          Full log: {launch.logPath}
        </Typography>
      ) : null}
    </Box>
  );
}
