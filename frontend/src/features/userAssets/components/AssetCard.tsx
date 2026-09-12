import React, { useCallback, useMemo, useState } from "react";
import { Typography } from "@mui/material";
import { styled } from "@mui/material/styles";
import {
  MediaAssetCard,
  MediaAssetCardActionButton,
} from "./MediaAssetCard";
import DeleteIcon from "@mui/icons-material/Delete";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import ReplayIcon from "@mui/icons-material/Replay";
import TimelineIcon from "@mui/icons-material/Timeline";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import FavoriteIcon from "@mui/icons-material/Favorite";
import FavoriteBorderIcon from "@mui/icons-material/FavoriteBorder";
import type { Asset } from "../../../types/Asset";
import {
  insertAssetAtTime,
  useTimelineClipCountForAsset,
} from "../../timeline";
import { getTimelineSelectionStartFromAsset } from "../../timelineSelection";
import { useAssetStore } from "../useAssetStore";
import { deleteAssetWithConfirmation } from "../utils/deleteAssetWithConfirmation";
import { canRegenerateAsset, regenerateAsset } from "../assetRegenerator";
import { toExtensionAssetSnapshot } from "../api";
import { AppMenu } from "../../../core/shell/AppMenu";
import type { HostMenuItemDescriptor } from "../../../core/shell/menuDescriptors";
import type { HostMenuSubject } from "../../../core/shell/hostMenus";

interface AssetCardActionsProps {
  asset: Asset;
  hideActions?: boolean;
  onDeleteAll?: (familyId: string) => void;
  onShowFamily?: (familyId: string) => void;
}

interface AssetCardProps extends AssetCardActionsProps {
  disableDrag?: boolean;
  isSelected?: boolean;
  onSelect?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onRequestPreview?: (assetId: string) => void;
  layout?: "default" | "square";
}

const StyledFavouriteButton = styled(MediaAssetCardActionButton)({
  left: 4,
});

const StyledMenuButton = styled(MediaAssetCardActionButton)({
  right: 4,
});

const MENU_ANCHOR_ORIGIN = {
  vertical: "bottom",
  horizontal: "right",
} as const;

const MENU_TRANSFORM_ORIGIN = {
  vertical: "top",
  horizontal: "right",
} as const;

function AssetCardActions({
  asset,
  hideActions = false,
  onDeleteAll,
  onShowFamily,
}: AssetCardActionsProps) {
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);

  const deleteAsset = useAssetStore((state) => state.deleteAsset);
  const updateAsset = useAssetStore((state) => state.updateAsset);
  const timelineClipCount = useTimelineClipCountForAsset(asset.id);
  const timelineSelectionStart = getTimelineSelectionStartFromAsset(asset);
  const canRegenerate = canRegenerateAsset(asset);
  const canDeleteAll = Boolean(asset.familyId && onDeleteAll);
  const canShowFamily = Boolean(asset.familyId && onShowFamily);
  const isMenuOpen = Boolean(menuAnchorEl);
  const assetMenuContext = useMemo<HostMenuSubject<"library.item.actions">>(
    () => ({ slot: "library.item.actions", asset: toExtensionAssetSnapshot(asset) }),
    [asset],
  );

  const handleOpenMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.preventDefault();
      setMenuAnchorEl(event.currentTarget);
    },
    [],
  );

  const handleCloseMenu = useCallback(() => {
    setMenuAnchorEl(null);
  }, []);

  const handleDelete = useCallback(() => {
    handleCloseMenu();
    void deleteAssetWithConfirmation({
      assetId: asset.id,
      deleteAsset,
      timelineClipCount,
    });
  }, [asset.id, deleteAsset, handleCloseMenu, timelineClipCount]);

  const handleSendToTimeline = useCallback(() => {
    handleCloseMenu();
    if (timelineSelectionStart === null) {
      return;
    }

    insertAssetAtTime(asset, timelineSelectionStart);
  }, [asset, handleCloseMenu, timelineSelectionStart]);

  const handleRegenerate = useCallback(async () => {
    handleCloseMenu();

    try {
      await regenerateAsset(asset);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to load workflow metadata";
      window.alert(message);
    }
  }, [asset, handleCloseMenu]);

  const handleOpenFamily = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.preventDefault();
      if (asset.familyId && onShowFamily) {
        onShowFamily(asset.familyId);
      }
    },
    [asset.familyId, onShowFamily],
  );

  const handleFavouriteToggle = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.preventDefault();
      void updateAsset(asset.id, { favourite: !asset.favourite });
    },
    [asset.favourite, asset.id, updateAsset],
  );

  const handleDeleteAll = useCallback(() => {
    handleCloseMenu();
    if (asset.familyId && onDeleteAll) {
      onDeleteAll(asset.familyId);
    }
  }, [asset.familyId, handleCloseMenu, onDeleteAll]);

  // Menu as data; all items remain inline actions because they are coupled to
  // component props/callbacks (family handlers, confirmation flows).
  const assetMenuItems: HostMenuItemDescriptor[] = [
    ...(canRegenerate
      ? [
          {
            kind: "action",
            id: "regenerate",
            label: "Regenerate",
            icon: <ReplayIcon fontSize="small" />,
            group: "1_asset",
            run: () => void handleRegenerate(),
          } satisfies HostMenuItemDescriptor,
        ]
      : []),
    ...(timelineSelectionStart !== null
      ? [
          {
            kind: "action",
            id: "send-to-timeline",
            label: "Send to Timeline",
            icon: <TimelineIcon fontSize="small" />,
            group: "1_asset",
            run: handleSendToTimeline,
          } satisfies HostMenuItemDescriptor,
        ]
      : []),
    ...(canDeleteAll
      ? [
          {
            kind: "action",
            id: "delete-all",
            label: "Delete all",
            icon: <DeleteIcon fontSize="small" />,
            group: "1_asset",
            run: handleDeleteAll,
          } satisfies HostMenuItemDescriptor,
        ]
      : []),
    {
      kind: "action",
      id: "delete",
      label: "Delete",
      icon: <DeleteIcon fontSize="small" />,
      group: "1_asset",
      run: handleDelete,
    },
  ];

  return (
    <>
      {!hideActions ? (
        <StyledFavouriteButton
          size="small"
          onClick={handleFavouriteToggle}
          onPointerDown={(event) => event.stopPropagation()}
          aria-label={
            asset.favourite ? "Remove from favourites" : "Add to favourites"
          }
          title={
            asset.favourite ? "Remove from favourites" : "Add to favourites"
          }
          sx={{
            color: asset.favourite ? "#ff4d4f" : "white",
          }}
        >
          {asset.favourite ? (
            <FavoriteIcon fontSize="small" />
          ) : (
            <FavoriteBorderIcon fontSize="small" />
          )}
        </StyledFavouriteButton>
      ) : null}

      {!hideActions && canShowFamily ? (
        <StyledMenuButton
          size="small"
          onClick={handleOpenFamily}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Open family"
          title="Open family"
          sx={{ right: 34 }}
        >
          <FolderOpenIcon fontSize="small" />
        </StyledMenuButton>
      ) : null}

      {!hideActions ? (
        <StyledMenuButton
          size="small"
          onClick={handleOpenMenu}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Asset actions"
          title="Asset actions"
        >
          <MoreVertIcon fontSize="small" />
        </StyledMenuButton>
      ) : null}
      {!hideActions && isMenuOpen ? (
        <AppMenu
          menuId="library.item.actions"
          subject={assetMenuContext}
          items={assetMenuItems}
          open
          onClose={handleCloseMenu}
          anchorEl={menuAnchorEl}
          anchorOrigin={MENU_ANCHOR_ORIGIN}
          transformOrigin={MENU_TRANSFORM_ORIGIN}
          onClick={(event) => event.stopPropagation()}
          extensionItemTestIdPrefix="extension-asset-menu-item-"
        />
      ) : null}
    </>
  );
}

const MemoizedAssetCardActions = React.memo(AssetCardActions);

function AssetCardComponent({
  asset,
  disableDrag = false,
  hideActions = false,
  isSelected = false,
  onDeleteAll,
  onShowFamily,
  onSelect,
  onRequestPreview,
  layout = "default",
}: AssetCardProps) {
  return (
    <MediaAssetCard
      id={asset.id}
      dragId={`asset_${asset.id}`}
      name={asset.name}
      asset={asset}
      disableDrag={disableDrag}
      isSelected={isSelected}
      layout={layout}
      onSelect={onSelect}
      onRequestPreview={onRequestPreview}
      metadata={
        <Typography
          variant="caption"
          display="block"
          sx={{ fontSize: "0.65rem", color: "#aaa" }}
        >
          {asset.createdAt
            ? new Date(asset.createdAt).toLocaleTimeString()
            : "Unknown Time"}
        </Typography>
      }
    >
      <MemoizedAssetCardActions
        asset={asset}
        hideActions={hideActions}
        onDeleteAll={onDeleteAll}
        onShowFamily={onShowFamily}
      />
    </MediaAssetCard>
  );
}

export const AssetCard = React.memo(AssetCardComponent);
