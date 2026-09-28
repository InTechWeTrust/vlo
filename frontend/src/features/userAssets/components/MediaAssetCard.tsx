import { memo, useMemo, type MouseEvent, type ReactNode } from "react";
import { Box, IconButton, Paper, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";
import { useDraggable } from "@dnd-kit/core";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import GradientIcon from "@mui/icons-material/Gradient";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import ZoomInIcon from "@mui/icons-material/ZoomIn";
import type { Asset } from "../../../types/Asset";
import type { BaseClip, CompositeAsset } from "../../../types/TimelineTypes";
import { createClipFromAsset } from "../../timeline";

interface MediaAssetCardProps {
  id: string;
  dragId: string;
  name: string;
  asset?: Asset;
  /** Override timeline placement while keeping the media asset usable by drop slots. */
  clip?: BaseClip;
  compositeAsset?: CompositeAsset;
  disableDrag?: boolean;
  isSelected?: boolean;
  layout?: "default" | "square";
  onSelect?: (event: MouseEvent<HTMLDivElement>) => void;
  onRequestPreview?: (assetId: string) => void;
  metadata: ReactNode;
  children?: ReactNode;
  fallback?: ReactNode;
  testId?: string;
}

// Styled Components for better performance
const StyledCard = styled(Paper, {
  shouldForwardProp: (prop) =>
    !["isDragDisabled", "isDragging", "isSelected", "layout"].includes(
      String(prop),
    ),
})<{
  isDragDisabled?: boolean;
  isDragging?: boolean;
  isSelected?: boolean;
  layout: "default" | "square";
}>(({ isDragDisabled, isDragging, isSelected, layout }) => ({
  width: "100%",
  backgroundColor: "#252525",
  color: "white",
  overflow: "hidden",
  cursor: isDragDisabled ? "pointer" : "grab",
  transition: "transform 0.1s, box-shadow 0.1s, outline-color 0.1s",
  "&:hover": { transform: "scale(1.02)" },
  position: "relative",
  opacity: isDragging ? 0.5 : 1,
  outline: isSelected ? "2px solid #4dabf5" : "2px solid transparent",
  outlineOffset: "-2px",
  boxShadow: isSelected ? "0 0 0 1px rgba(77, 171, 245, 0.35)" : "none",
  ...(layout === "square"
    ? {
        aspectRatio: "1 / 1",
      }
    : {}),
}));

const ThumbnailContainer = styled(Box, {
  shouldForwardProp: (prop) => prop !== "layout",
})<{ layout: "default" | "square" }>(({ layout }) => ({
  height: layout === "square" ? "100%" : 80,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "#000",
  position: "relative",
}));

const OverlayControls = styled(Box)({
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "rgba(0,0,0,0.3)",
  opacity: 1,
  transition: "opacity 0.2s",
  "&:hover": { opacity: 1 },
});

const DurationBadge = styled(Box)({
  position: "absolute",
  bottom: 4,
  right: 4,
  backgroundColor: "rgba(0, 0, 0, 0.7)",
  paddingLeft: 4,
  paddingRight: 4,
  borderRadius: 2,
  pointerEvents: "none",
});

export const MediaAssetCardActionButton = styled(IconButton)({
  position: "absolute",
  top: 4,
  backgroundColor: "rgba(0, 0, 0, 0.5)",
  color: "white",
  padding: 4,
  "&:hover": {
    backgroundColor: "rgba(0, 0, 0, 0.75)",
  },
  zIndex: 10,
});

const MetadataArea = styled(Box, {
  shouldForwardProp: (prop) => prop !== "layout",
})<{ layout: "default" | "square" }>(({ layout }) => ({
  padding: 8,
  ...(layout === "square"
    ? {
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 2,
        paddingTop: 28,
        background:
          "linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, rgba(9, 9, 9, 0.84) 44%, rgba(9, 9, 9, 0.96) 100%)",
      }
    : {}),
}));

const ContentRoot = styled(Box)({
  height: "100%",
});

const EMPTY_PREVIEW_STYLES = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  height: "100%",
} as const;

const MEDIA_ACTION_STYLES = {
  color: "white",
} as const;

const DURATION_TEXT_STYLES = {
  fontSize: "0.6rem",
  color: "white",
} as const;

// Helper to format seconds into MM:SS
const formatDuration = (seconds?: number) => {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

interface MediaAssetThumbnailProps {
  asset?: Asset;
  name: string;
  layout: "default" | "square";
  onRequestPreview?: (assetId: string) => void;
  fallback?: ReactNode;
}

function MediaAssetThumbnail({
  asset,
  name,
  layout,
  onRequestPreview,
  fallback,
}: MediaAssetThumbnailProps) {
  const displayImage =
    asset?.thumbnail || (asset?.type === "image" ? asset.src : null);
  const handlePlayToggle = (event: MouseEvent) => {
    event.stopPropagation();
    if (asset) onRequestPreview?.(asset.id);
  };
  return (
    <ThumbnailContainer layout={layout}>
      {displayImage ? (
        <img
          src={displayImage}
          alt={name}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <Box sx={EMPTY_PREVIEW_STYLES}>
          {asset?.type === "audio" ? (
            <MusicNoteIcon
              data-testid="asset-card-audio-icon"
              sx={{ fontSize: 40, color: "#888" }}
            />
          ) : asset?.type === "lut" ? (
            <GradientIcon sx={{ fontSize: 40, color: "#888" }} />
          ) : (
            fallback ?? (
              <Typography variant="caption" sx={{ color: "#555" }}>
                No Preview
              </Typography>
            )
          )}
        </Box>
      )}

      {/* Preview / Playback Overlay Controls */}
      {onRequestPreview &&
      (asset?.type === "video" ||
        asset?.type === "audio" ||
        (asset?.type === "image" && displayImage)) ? (
        <OverlayControls>
          <IconButton
            onClick={handlePlayToggle}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={
              asset?.type === "video"
                ? "Preview video"
                : asset?.type === "image"
                  ? "Preview image"
                  : "Preview audio"
            }
            sx={MEDIA_ACTION_STYLES}
          >
            {asset?.type === "image" ? (
              <ZoomInIcon sx={{ fontSize: 32 }} />
            ) : (
              <PlayCircleOutlineIcon sx={{ fontSize: 32 }} />
            )}
          </IconButton>
        </OverlayControls>
      ) : null}

      {/* Duration Badge */}
      {asset?.type !== "image" && asset?.duration && (
        <DurationBadge
          sx={{
            bottom: layout === "square" ? 56 : 4,
          }}
        >
          <Typography
            variant="caption"
            sx={DURATION_TEXT_STYLES}
          >
            {formatDuration(asset?.duration)}
          </Typography>
        </DurationBadge>
      )}
    </ThumbnailContainer>
  );
}

// Drag context and action/menu changes should not rerender the media subtree.
const MemoizedMediaAssetThumbnail = memo(MediaAssetThumbnail);

export function MediaAssetCard({
  id,
  dragId,
  name,
  asset,
  clip,
  compositeAsset,
  disableDrag = false,
  isSelected = false,
  layout = "default",
  onSelect,
  onRequestPreview,
  metadata,
  children,
  fallback,
  testId = "asset-card",
}: MediaAssetCardProps) {
  const draggableData = useMemo(
    () => ({
      type: "asset",
      asset,
      // A hand-placed drop keeps any inpaint framing but starts with it off;
      // Send to Timeline is the path that restores it.
      clip:
        clip ??
        (asset && asset.type !== "lut"
          ? createClipFromAsset(asset, { metadataPlacement: "disabled" })
          : null),
      ...(compositeAsset ? { compositeAsset } : {}),
    }),
    [asset, clip, compositeAsset],
  );
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId,
    data: draggableData,
    disabled: disableDrag,
  });
  const handlePlayToggle = (event: MouseEvent) => {
    event.stopPropagation();
    if (asset) onRequestPreview?.(asset.id);
  };
  return (
    <StyledCard
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      elevation={2}
      isDragDisabled={disableDrag}
      isDragging={isDragging}
      isSelected={isSelected}
      layout={layout}
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(event);
      }}
      onDoubleClick={handlePlayToggle}
      data-asset-id={asset?.id ?? id}
      data-composite-id={compositeAsset?.id}
      data-drag-disabled={disableDrag ? "true" : "false"}
      data-selected={isSelected ? "true" : "false"}
      data-testid={testId}
    >
      <ContentRoot>
        <MemoizedMediaAssetThumbnail
          asset={asset}
          name={name}
          layout={layout}
          onRequestPreview={onRequestPreview}
          fallback={fallback}
        />

        {children}
        {/* Metadata Area */}
        <MetadataArea layout={layout}>
          <Typography
            variant="caption"
            noWrap
            display="block"
            sx={{
              fontWeight: 500,
              pr: layout === "square" ? 3 : 0,
            }}
            title={name} // Tooltip for long names
            data-testid={`${testId}-name`}
          >
            {name}
          </Typography>
          {metadata}
        </MetadataArea>
      </ContentRoot>
    </StyledCard>
  );
}

