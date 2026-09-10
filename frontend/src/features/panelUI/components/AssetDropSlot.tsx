import React from "react";
import { Box, Typography, IconButton, CircularProgress } from "@mui/material";
import { styled } from "@mui/material/styles";
import { useDroppable, useDndContext, useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import CloseIcon from "@mui/icons-material/Close";
import EditIcon from "@mui/icons-material/Edit";
import type { Asset, AssetType } from "../../../types/Asset";
import { assetMatchesType } from "../../../shared/utils/assetTypeDetection";
import type {
  AssetDropSlotProps,
  AssetDropSlotReorderData,
} from "./assetDropSlotTypes";
import {
  acceptsReorderDrag,
  getExternalFileDragHighlight,
  getFirstAcceptedFile,
  hasDraggedFiles,
} from "./assetDropSlotUtils";

const SLOT_SIZE = 80;

const SlotContainer = styled(Box)({
  display: "inline-flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 4,
});

const SlotBox = styled(Box, {
  shouldForwardProp: (prop) =>
    prop !== "filled" && prop !== "highlight",
})<{
  filled?: boolean;
  highlight?: "compatible" | "incompatible" | "external" | null;
}>(
  ({ filled, highlight }) => ({
    width: SLOT_SIZE,
    height: SLOT_SIZE,
    borderRadius: 6,
    backgroundColor: "#1a1a1a",
    border:
      highlight === "compatible"
        ? "2px solid #90caf9"
        : highlight === "incompatible"
          ? "2px solid #f44336"
          : highlight === "external"
            ? "2px dashed #b0bec5"
          : filled
            ? "1px solid #444"
            : "1px dashed #555",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    overflow: "hidden",
    transition: "border-color 0.15s",
  }),
);

const ClearButton = styled(IconButton)({
  position: "absolute",
  top: 2,
  right: 2,
  padding: 2,
  backgroundColor: "rgba(0, 0, 0, 0.6)",
  color: "#fff",
  opacity: 0,
  transition: "opacity 0.15s",
  "&:hover": {
    backgroundColor: "rgba(200, 0, 0, 0.8)",
  },
});

const EditButton = styled(IconButton)({
  position: "absolute",
  top: 2,
  left: 2,
  padding: 2,
  backgroundColor: "rgba(0, 0, 0, 0.6)",
  color: "#fff",
  opacity: 0,
  transition: "opacity 0.15s",
  "&:hover": {
    backgroundColor: "rgba(33, 150, 243, 0.85)",
  },
});

function formatAcceptLabel(accept: AssetType[]): string {
  return accept.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" / ");
}

function AssetDropSlotComponent({
  surfaceId,
  id,
  accept,
  acceptAsset,
  acceptExternal,
  value,
  onClear,
  onEdit,
  onDrop,
  onExternalDrop,
  onSelect,
  label,
  reorderData,
  onReorderDrop,
  acceptReorderFrom,
  disabledActions,
}: AssetDropSlotProps) {
  const filled = value != null;
  // A refused action is inert here, not merely undecorated: the callback may
  // still be supplied by a caller that offers it in other contexts.
  const selectRefused = disabledActions?.select;
  const editRefused = disabledActions?.edit;
  const externalRefused = disabledActions?.externalDrop;
  const clearRefused = disabledActions?.clear;
  const canSelect = !selectRefused && typeof onSelect === "function";
  const canEdit = !editRefused && typeof onEdit === "function";
  const canExternalDrop = !externalRefused && typeof onExternalDrop === "function";

  // Refusing reorder makes the slot undraggable as well as an invalid drop
  // target: leaving it draggable lets the user carry it to another accepting
  // slot, which is the same action by a different route.
  const isReorderable =
    filled && reorderData != null && !disabledActions?.reorder;
  const [externalHighlight, setExternalHighlight] = React.useState<
    "compatible" | "incompatible" | "external" | null
  >(null);
  const externalDragDepthRef = React.useRef(0);

  /**
   * The caller's rule, narrowed to drags that started on this surface.
   *
   * Wrapped here rather than left to the caller: a surface is this component's
   * own business, and the predicate reaches the drop handler through the
   * droppable data, so it has to carry the check with it.
   */
  const acceptReorderHere = React.useCallback(
    (data: AssetDropSlotReorderData) =>
      data.surfaceId === surfaceId && acceptReorderFrom?.(data) !== false,
    [surfaceId, acceptReorderFrom],
  );

  // Namespaced by surface: two surfaces showing the same input would otherwise
  // register the same dnd id, and dnd-kit keeps one entry per id.
  const { setNodeRef: setDroppableNodeRef, isOver } = useDroppable({
    id: `asset-slot-${surfaceId}:${id}`,
    data: {
      type: "asset-slot",
      accept,
      acceptAsset,
      onDrop,
      onReorderDrop: disabledActions?.reorder ? undefined : onReorderDrop,
      acceptReorderFrom: acceptReorderHere,
      surfaceId,
    },
  });
  const {
    listeners,
    setNodeRef: setDraggableNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: `asset-slot-item-${surfaceId}:${id}`,
    // The surface is stamped here rather than asked of the caller: the slot is
    // the only thing that knows which copy of itself is being dragged.
    data: reorderData ? { ...reorderData, surfaceId } : undefined,
    disabled: !isReorderable,
  });
  const setNodeRef = React.useCallback(
    (node: HTMLElement | null) => {
      setDroppableNodeRef(node);
      setDraggableNodeRef(node);
    },
    [setDraggableNodeRef, setDroppableNodeRef],
  );

  // Determine highlight state when dragging over
  const { active } = useDndContext();
  let highlight: "compatible" | "incompatible" | "external" | null = null;
  if (isOver && active?.data.current?.type === "asset") {
    const draggedAsset = active.data.current.asset as Asset | undefined;
    highlight =
      draggedAsset &&
      (accept.some((acceptedType) => assetMatchesType(draggedAsset, acceptedType)) ||
        acceptAsset?.(draggedAsset) === true)
        ? "compatible"
        : "incompatible";
  }
  // One predicate for the highlight and the drop. Anything the slot would turn
  // away has to *look* turned away: leaving a rejected drag neutral reads as
  // "nothing here", and the user finds out it was refused by dropping it.
  // Hovering an item over its own slot stays neutral — that is a no-op, not a
  // refusal.
  if (
    isOver &&
    active?.data.current?.type === "media-input" &&
    active.data.current.inputId !== id
  ) {
    highlight = acceptsReorderDrag({
      refused: Boolean(disabledActions?.reorder),
      hasHandler: typeof onReorderDrop === "function",
      accept: acceptReorderHere,
      from: {
        type: "media-input",
        surfaceId: String(active.data.current.surfaceId),
        inputId: String(active.data.current.inputId),
      },
    })
      ? "compatible"
      : "incompatible";
  }
  if (externalHighlight) {
    highlight = externalHighlight;
  }

  const externalAccept = acceptExternal ?? accept;
  const thumbnail = value?.thumbnail ?? null;
  const status = value?.status ?? null;

  return (
    <SlotContainer
      sx={{
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.65 : 1,
        zIndex: isDragging ? 1 : "auto",
      }}
    >
      {label && (
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", fontSize: "0.65rem" }}
        >
          {label}
        </Typography>
      )}
      <SlotBox
        ref={setNodeRef}
        filled={filled}
        highlight={highlight}
        data-drop-slot-id={id}
        {...(isReorderable ? listeners : {})}
        sx={{
          "&:hover .drop-slot-clear": {
            opacity: 1,
          },
          "&:hover .drop-slot-edit": {
            opacity: 1,
          },
          cursor: isReorderable
            ? isDragging
              ? "grabbing"
              : "grab"
            : canSelect
              ? "pointer"
              : "default",
        }}
        role={canSelect ? "button" : undefined}
        tabIndex={canSelect ? 0 : -1}
        onClick={canSelect ? onSelect : undefined}
        onDragEnter={(event) => {
          if (!canExternalDrop || !hasDraggedFiles(event.dataTransfer)) {
            return;
          }

          event.preventDefault();
          externalDragDepthRef.current += 1;
          setExternalHighlight(
            getExternalFileDragHighlight(event.dataTransfer, externalAccept),
          );
        }}
        onDragOver={(event) => {
          if (!canExternalDrop || !hasDraggedFiles(event.dataTransfer)) {
            return;
          }

          event.preventDefault();
          const nextHighlight = getExternalFileDragHighlight(
            event.dataTransfer,
            externalAccept,
          );
          event.dataTransfer.dropEffect =
            nextHighlight === "incompatible" ? "none" : "copy";
          setExternalHighlight(nextHighlight);
        }}
        onDragLeave={(event) => {
          if (!canExternalDrop || !hasDraggedFiles(event.dataTransfer)) {
            return;
          }

          event.preventDefault();
          externalDragDepthRef.current = Math.max(
            0,
            externalDragDepthRef.current - 1,
          );
          if (externalDragDepthRef.current === 0) {
            setExternalHighlight(null);
          }
        }}
        onDrop={(event) => {
          if (!canExternalDrop || !hasDraggedFiles(event.dataTransfer)) {
            return;
          }

          event.preventDefault();
          externalDragDepthRef.current = 0;
          setExternalHighlight(null);
          const acceptedFile = getFirstAcceptedFile(
            Array.from(event.dataTransfer.files),
            externalAccept,
          );
          if (!acceptedFile) {
            return;
          }
          void onExternalDrop?.(acceptedFile);
        }}
        onKeyDown={(event) => {
          if (!canSelect) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
      >
        {filled ? (
          <>
            {status === "preparing" ? (
              <CircularProgress size={24} sx={{ color: "#90caf9" }} />
            ) : status === "error" ? (
              <ErrorOutlineIcon sx={{ fontSize: 32, color: "#f44336" }} />
            ) : value!.type === "audio" ? (
              <MusicNoteIcon sx={{ fontSize: 32, color: "#888" }} />
            ) : thumbnail ? (
              <img
                src={thumbnail}
                alt={value!.name}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            ) : (
              <Typography
                variant="caption"
                sx={{ color: "#555", fontSize: "0.6rem" }}
              >
                No Preview
              </Typography>
            )}
            {(canEdit || editRefused) && (
              <EditButton
                className="drop-slot-edit"
                size="small"
                aria-label="Edit"
                disabled={Boolean(editRefused)}
                title={editRefused}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!canEdit) return;
                  onEdit?.();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <EditIcon sx={{ fontSize: 12 }} />
              </EditButton>
            )}
            {onClear && (
              <ClearButton
                className="drop-slot-clear"
                size="small"
                disabled={Boolean(clearRefused)}
                title={clearRefused}
                onClick={(e) => {
                  e.stopPropagation();
                  if (clearRefused) return;
                  onClear();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <CloseIcon sx={{ fontSize: 12 }} />
              </ClearButton>
            )}
          </>
        ) : (
          <Box
            sx={{
              textAlign: "center",
              px: 0.5,
              userSelect: "none",
              lineHeight: 1.15,
            }}
          >
            <Typography variant="caption" sx={{ color: "#555", fontSize: "0.6rem" }}>
              {formatAcceptLabel(accept)}
            </Typography>
            {canSelect ? (
              <Typography
                variant="caption"
                sx={{ color: "#777", fontSize: "0.55rem", display: "block" }}
              >
                Drop or click
              </Typography>
            ) : selectRefused ? (
              <Typography
                variant="caption"
                title={selectRefused}
                sx={{ color: "#555", fontSize: "0.55rem", display: "block" }}
              >
                Drop only
              </Typography>
            ) : null}
          </Box>
        )}
      </SlotBox>
      {filled && (
        <Typography
          variant="caption"
          noWrap
          sx={{
            color: status === "error" ? "error.main" : "text.secondary",
            fontSize: "0.6rem",
            maxWidth: SLOT_SIZE,
          }}
          title={value!.statusMessage ?? value!.name}
        >
          {value!.statusMessage ?? value!.name}
        </Typography>
      )}
    </SlotContainer>
  );
}

export const AssetDropSlot = React.memo(AssetDropSlotComponent);
