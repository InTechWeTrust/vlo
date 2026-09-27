import { Box, CircularProgress, Typography } from "@mui/material";

interface ComfyuiLaunchProgressProps {
  latestOutput: string | null;
  message?: string;
}

export function ComfyuiLaunchProgress({
  latestOutput,
  message = "ComfyUI is starting; this can take a minute on first launch…",
}: ComfyuiLaunchProgressProps) {
  return (
    <Box sx={{ mt: 1.5 }} data-testid="comfyui-launch-progress">
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          color: "text.secondary",
        }}
      >
        <CircularProgress size={14} />
        <Typography variant="caption">{message}</Typography>
      </Box>
      {latestOutput ? (
        <Typography
          variant="caption"
          title={latestOutput}
          sx={{
            display: "block",
            mt: 0.5,
            color: "text.secondary",
            fontFamily: "monospace",
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {latestOutput}
        </Typography>
      ) : null}
    </Box>
  );
}
