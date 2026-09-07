import { useCallback, useEffect, useRef, useState } from "react";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import { Close } from "@mui/icons-material";
import { ViewRegionMount } from "../../core/shell/ViewRegionMount";
import { useViewRegion } from "../../core/shell/useViewRegion";

/**
 * The floating workspace over the editor
 * (docs/minimax-prompt-composer-extension-plan.md §4, 1D).
 *
 * It exists because the modal host is app-wide — it has to work on the
 * projects page, before any project is open — and so mounts *outside* the
 * editor's `DndContext`. A `useDroppable` inside a modal therefore never
 * fires, silently. This host is rendered from `EditorLayout`, inside that
 * context, so a panel here can accept library drags the way a sidebar view can.
 *
 * Non-blocking on purpose: the point of a composer is to see and drag the
 * panel behind it, which a dialog forbids. It is opened by `openView` or the
 * user and closed from its own header; nothing auto-selects into it.
 */

const DEFAULT_SIZE = { width: 520, height: 460 };
const MIN_SIZE = { width: 320, height: 240 };
const EDGE_MARGIN_PX = 16;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type DragMode = { kind: "move" | "resize"; pointerId: number; originX: number; originY: number; rect: Rect };

/** Keeps the panel reachable: never fully off-screen, never below its floor. */
function clampRect(rect: Rect): Rect {
  const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
  const width = Math.max(MIN_SIZE.width, Math.min(rect.width, viewportWidth));
  const height = Math.max(MIN_SIZE.height, Math.min(rect.height, viewportHeight));
  return {
    width,
    height,
    x: Math.max(
      EDGE_MARGIN_PX - width,
      Math.min(rect.x, viewportWidth - EDGE_MARGIN_PX),
    ),
    y: Math.max(0, Math.min(rect.y, viewportHeight - EDGE_MARGIN_PX)),
  };
}

export function EditorOverlayHost() {
  const { views, selectedViewId, closeRegion } = useViewRegion(
    "editor-overlay",
    // Nothing opens itself here: an extension registering a workspace must not
    // put a floating panel over the editor until something asks for it.
    { autoSelect: false },
  );
  const [rect, setRect] = useState<Rect>(() =>
    clampRect({
      x: 120,
      y: 96,
      width: DEFAULT_SIZE.width,
      height: DEFAULT_SIZE.height,
    }),
  );
  const dragRef = useRef<DragMode | null>(null);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.originX;
    const dy = event.clientY - drag.originY;
    setRect(
      clampRect(
        drag.kind === "move"
          ? { ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy }
          : {
              ...drag.rect,
              width: drag.rect.width + dx,
              height: drag.rect.height + dy,
            },
      ),
    );
  }, []);

  const handlePointerUp = useCallback((event: PointerEvent) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
  }, []);

  useEffect(() => {
    // On the window, not the handle: a fast drag outruns the element, and the
    // gesture has to keep tracking when the pointer leaves it.
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  useEffect(() => {
    const onResize = () => setRect((current) => clampRect(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The gesture reads the rect from a ref rather than the render closure: a
  // pointer-down can arrive between a resize and the re-render that follows it.
  const rectRef = useRef(rect);
  useEffect(() => {
    rectRef.current = rect;
  }, [rect]);

  const beginDrag = useCallback(
    (kind: DragMode["kind"]) => (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragRef.current = {
        kind,
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        rect: rectRef.current,
      };
    },
    [],
  );

  const active = views.find((view) => view.id === selectedViewId);
  if (!active) return null;

  return (
    <Box
      data-testid="editor-overlay"
      role="dialog"
      aria-label={active.title}
      // Non-modal: the editor behind it stays interactive, which is the whole
      // reason this is not a modal.
      aria-modal={false}
      sx={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        // Above the regions and the portable-view host, below the app's own
        // modals — a dialog the user opens on top of this still wins.
        zIndex: 1200,
        display: "flex",
        flexDirection: "column",
        bgcolor: "#161616",
        border: "1px solid #3a3a3a",
        borderRadius: 1,
        boxShadow: "0 18px 48px rgba(0, 0, 0, 0.55)",
        overflow: "hidden",
      }}
    >
      <Box
        onPointerDown={beginDrag("move")}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          py: 0.5,
          cursor: "move",
          borderBottom: "1px solid #2a2a2a",
          bgcolor: "#1c1c1c",
          touchAction: "none",
          flexShrink: 0,
        }}
      >
        <Typography
          sx={{ flex: 1, fontSize: "0.75rem", fontWeight: 600, minWidth: 0 }}
          noWrap
        >
          {active.title}
        </Typography>
        <Tooltip title="Close">
          <IconButton
            size="small"
            aria-label={`Close ${active.title}`}
            onClick={closeRegion}
            sx={{ p: 0.25 }}
          >
            <Close sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>
      {/* `overflow: auto` as the bottom dock and player aside do it: the panel
          is user-resizable, so a workspace taller than the frame has to scroll
          rather than be clipped by the frame's own `overflow: hidden`. */}
      <Box
        sx={{ position: "relative", flexGrow: 1, minHeight: 0, overflow: "auto" }}
      >
        <ViewRegionMount
          region="editor-overlay"
          views={views}
          activeViewId={selectedViewId}
        />
      </Box>
      <Box
        onPointerDown={beginDrag("resize")}
        aria-hidden={true}
        sx={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 16,
          height: 16,
          cursor: "nwse-resize",
          touchAction: "none",
          background:
            "linear-gradient(135deg, transparent 50%, #4a4a4a 50%, #4a4a4a 70%, transparent 70%)",
        }}
      />
    </Box>
  );
}
