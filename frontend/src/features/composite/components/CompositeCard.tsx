import {
  memo,
  useCallback,
  useMemo,
  useState,
  type MouseEvent,
} from "react";
import { Tooltip, Typography } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import AddToTimelineIcon from "@mui/icons-material/PlaylistAdd";
import LayersIcon from "@mui/icons-material/Layers";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import RefreshIcon from "@mui/icons-material/Refresh";
import SensorsIcon from "@mui/icons-material/Sensors";
import type { CompositeAsset } from "../../../types/TimelineTypes";
import {
  MediaAssetCard,
  MediaAssetCardActionButton,
  openAssetInMiniEditor,
  useAssetStore,
} from "../../userAssets";
import { tickToMediaSeconds } from "../../renderer/utils/mediaTime";
import { useProjectStore } from "../../project";
import { getProjectDimensions } from "../../renderer/utils/dimensions";
import { resolveCompositeBakeSelection } from "../utils/resolveCompositeBakeSelection";
import { createCompositeBaseClipFromAsset } from "../utils/createCompositeClip";
import { useCompositeLibraryStore } from "../useCompositeLibraryStore";
import {
  setCompositeForceLive,
  useCompositeBakeRuntimeStatus,
  useIsCompositeForceLive,
} from "../useCompositeRenderStatusStore";
import { AppMenu } from "../../../core/shell/AppMenu";
import type { HostMenuSubject } from "../../../core/shell/hostMenus";
import type { HostMenuItemDescriptor } from "../../../core/shell/menuDescriptors";

const COMPOSITE_THUMBNAIL_FALLBACK = <LayersIcon sx={{ fontSize: 40, color: "#888" }} />;

interface CompositeCardProps {
  composite: CompositeAsset;
  isSelected: boolean;
  disableDrag?: boolean;
  onSelect: (event: MouseEvent<HTMLDivElement>) => void;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onPlaceOnTimeline: () => void;
}

function CompositeCardComponent({
  composite,
  isSelected,
  disableDrag = false,
  onSelect,
  onOpen,
  onRename,
  onDelete,
  onPlaceOnTimeline,
}: CompositeCardProps) {
  const assets = useAssetStore((state) => state.assets);
  const projectFps = useProjectStore((state) => state.config.fps);
  const projectAspectRatio = useProjectStore(
    (state) => state.config.aspectRatio,
  );
  const bakedAsset = useMemo(() => {
    // Legacy documents have only a media pointer. Versioned bakes must match
    // the actual render inputs, including project settings and source assets.
    if (!composite.bake) {
      return assets.find((asset) => asset.id === composite.bakedAssetId);
    }
    const { validity } = resolveCompositeBakeSelection({
      composite,
      assets,
      projectFps,
      logicalDimensions: getProjectDimensions(projectAspectRatio),
    });
    return validity.valid
      ? assets.find((asset) => asset.id === validity.assetId)
      : undefined;
  }, [assets, composite, projectFps, projectAspectRatio]);
  const clip = useMemo(
    () => createCompositeBaseClipFromAsset(composite),
    [composite],
  );
  const handlePreview = useCallback(() => {
    if (bakedAsset) {
      void openAssetInMiniEditor(bakedAsset, {
        openerId: `composite-browser:${composite.id}`,
      });
    }
  }, [bakedAsset, composite.id]);
  const retryCompositeBake = useCompositeLibraryStore(
    (state) => state.retryCompositeBake,
  );
  const runtimeBake = useCompositeBakeRuntimeStatus(composite.id);
  const forceLive = useIsCompositeForceLive(composite.id);
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);
  const menuSubject = useMemo<HostMenuSubject<"library.composite.actions">>(
    () => ({
      slot: "library.composite.actions",
      composite: {
        id: composite.id,
        name: composite.name,
        durationTicks: composite.content.durationTicks,
        bakeStatus: composite.bake?.status ?? "live_only",
      },
    }),
    [
      composite.bake?.status,
      composite.content.durationTicks,
      composite.id,
      composite.name,
    ],
  );
  const stopAction = useCallback((event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleOpenMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      stopAction(event);
      setMenuAnchorEl(event.currentTarget);
    },
    [stopAction],
  );

  const handleCloseMenu = useCallback(() => {
    setMenuAnchorEl(null);
  }, []);

  const menuItems: HostMenuItemDescriptor[] = [
    {
      kind: "action",
      id: "edit",
      label: "Edit composite",
      icon: <EditIcon fontSize="small" />,
      group: "1_composite",
      run: onOpen,
    },
    {
      kind: "action",
      id: "place-on-timeline",
      label: "Place on timeline",
      icon: <AddToTimelineIcon fontSize="small" />,
      group: "1_composite",
      run: onPlaceOnTimeline,
    },
    {
      kind: "action",
      id: "rename",
      label: "Rename",
      icon: <DriveFileRenameOutlineIcon fontSize="small" />,
      group: "1_composite",
      run: onRename,
    },
    ...(composite.bake?.status === "failed"
      ? [
          {
            kind: "action",
            id: "retry-bake",
            label: "Retry background bake",
            icon: <RefreshIcon fontSize="small" />,
            group: "1_composite",
            run: () => {
              void retryCompositeBake(composite.id);
            },
          } satisfies HostMenuItemDescriptor,
        ]
      : []),
    {
      kind: "action",
      id: "delete",
      label: "Delete",
      icon: <DeleteOutlineIcon fontSize="small" color="error" />,
      group: "1_composite",
      run: onDelete,
    },
  ];

  return (
    <>
      <MediaAssetCard
        id={composite.id}
        dragId={`composite-asset-${composite.id}`}
        name={composite.name}
        asset={bakedAsset}
        clip={clip}
        compositeAsset={composite}
        isSelected={isSelected}
        disableDrag={disableDrag}
        onSelect={onSelect}
        onRequestPreview={bakedAsset ? handlePreview : undefined}
        fallback={COMPOSITE_THUMBNAIL_FALLBACK}
        testId="composite-card"
        metadata={
          <Typography
            variant="caption"
            data-testid="composite-bake-status"
            display="block"
            noWrap
            title={composite.bake?.error}
            sx={{
              fontSize: "0.65rem",
              color: composite.bake?.status === "failed" ? "#fecaca" : "#aaa",
            }}
          >
            {tickToMediaSeconds(composite.content.durationTicks).toFixed(2)}s
            {" · "}
            {runtimeBake?.status === "rendering"
              ? `Baking ${Math.round(runtimeBake.progress)}%`
              : runtimeBake?.status === "queued"
                ? "Bake queued"
                : composite.bake?.status === "failed"
                  ? `Bake failed: ${composite.bake.error ?? "Retry available"}`
                  : composite.bake?.status === "ready"
                    ? "Bake ready"
                    : "Live only"}
          </Typography>
        }
      >
        <Tooltip
          title={forceLive ? "Use automatic source policy" : "Force live rendering"}
        >
          <MediaAssetCardActionButton
            size="small"
            aria-label={
              forceLive ? "Use automatic source policy" : "Force live rendering"
            }
            aria-pressed={forceLive}
            onPointerDown={stopAction}
            onClick={(event) => {
              stopAction(event);
              setCompositeForceLive(composite.id, !forceLive);
            }}
            sx={{ left: 4, color: forceLive ? "#86efac" : "white" }}
          >
            <SensorsIcon fontSize="small" />
          </MediaAssetCardActionButton>
        </Tooltip>

        <MediaAssetCardActionButton
          size="small"
          aria-label="Composite actions"
          title="Composite actions"
          aria-haspopup="menu"
          aria-expanded={menuAnchorEl ? "true" : undefined}
          onPointerDown={stopAction}
          onClick={handleOpenMenu}
          sx={{ right: 4 }}
        >
          <MoreVertIcon fontSize="small" />
        </MediaAssetCardActionButton>
      </MediaAssetCard>

      <AppMenu
        menuId="library.composite.actions"
        subject={menuSubject}
        items={menuItems}
        open={Boolean(menuAnchorEl)}
        anchorEl={menuAnchorEl}
        onClose={handleCloseMenu}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        onClick={(event) => event.stopPropagation()}
        extensionItemTestIdPrefix="extension-composite-menu-item-"
      />
    </>
  );
}

export const CompositeCard = memo(CompositeCardComponent);
