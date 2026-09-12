import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DragEndEvent } from "@dnd-kit/core";
import { useAssetDrag } from "../../../timeline/hooks/dnd/useAssetDrag";
import { useAssetStore } from "../../../userAssets/useAssetStore";
import { useProjectStore } from "../../../project/useProjectStore";
import { getProjectDimensions } from "../../../renderer/utils/dimensions";
import { createCompositeBakeKey, serializeCompositeBakeKey } from "../../utils/compositeRenderContract";
import type { Asset } from "../../../../types/Asset";
import type { CompositeAsset } from "../../../../types/TimelineTypes";
import { TICKS_PER_SECOND } from "../../../timeline/constants";
import { CompositeCard } from "../CompositeCard";
import { useCompositeLibraryStore } from "../../useCompositeLibraryStore";
import { useCompositeRenderStatusStore } from "../../useCompositeRenderStatusStore";

const mocks = vi.hoisted(() => ({
  openPreview: vi.fn(),
  draggable: {
    attributes: { role: "button" },
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn(),
    isDragging: false,
  },
  useDraggable: vi.fn(),
}));

vi.mock("../../../timeline/hooks/dnd/useClipMove", () => ({
  useClipMove: () => ({ handleMove: vi.fn(), handleEnd: vi.fn() }),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: mocks.useDraggable,
}));

// Exercise the public entry point without loading the asset browser UI.
vi.mock("../../../userAssets", async () => ({
  ...await import("../../../userAssets/api"),
  ...await import("../../../userAssets/components/MediaAssetCard"),
  ...await import("../../../userAssets/useAssetStore"),
  openAssetInMiniEditor: mocks.openPreview,
}));

const bakedVideo: Asset = {
  id: "bake-1", name: "baked.mp4", type: "video", hash: "bake-hash",
  src: "source.mp4", thumbnail: "thumb.jpg", createdAt: 1, duration: 2.5,
};

function composite(): CompositeAsset {
  return {
    id: "composite-1",
    name: "Opening scene",
    bakedAssetId: "bake-1",
    createdAt: 1,
    updatedAt: 1,
    content: {
      clips: [],
      tracks: [],
      durationTicks: 2.5 * TICKS_PER_SECOND,
    },
  };
}

describe("CompositeCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAssetStore.setState({ assets: [] });
    useProjectStore.setState({ config: {
      ...useProjectStore.getState().config, fps: 30, aspectRatio: "16:9",
    } });
    mocks.draggable.isDragging = false;
    mocks.useDraggable.mockReturnValue(mocks.draggable);
    useCompositeRenderStatusStore.setState({
      renderingClipIds: new Set(),
      directRenderErrors: new Map(),
      bakeStatusByCompositeId: new Map(),
      forceLiveCompositeIds: new Set(),
      forceBakedCompositeIds: new Set(),
    });
  });

  it("configures dragging and renders fallback content", () => {
    const handlers = {
      onSelect: vi.fn(),
      onOpen: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onPlaceOnTimeline: vi.fn(),
    };
    render(
      <CompositeCard
        composite={composite()}
        isSelected
        disableDrag
        {...handlers}
      />,
    );

    expect(mocks.useDraggable).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "composite-asset-composite-1",
        disabled: true,
        data: expect.objectContaining({
          type: "asset",
          compositeAsset: expect.objectContaining({ id: "composite-1" }),
          clip: expect.objectContaining({ compositeId: "composite-1" }),
        }),
      }),
    );
    const card = screen.getByTestId("composite-card");
    expect(card).toHaveAttribute("data-selected", "true");
    expect(card).toHaveStyle({ cursor: "pointer", opacity: "1" });
    expect(screen.getByText("Opening scene")).toBeInTheDocument();
    expect(screen.getByTestId("composite-bake-status")).toHaveTextContent(
      "2.50s · Live only",
    );
  });

  it("renders a thumbnail and dragging state", () => {
    useAssetStore.setState({ assets: [bakedVideo] });
    mocks.draggable.isDragging = true;
    render(
      <CompositeCard
        composite={composite()}
        isSelected={false}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onPlaceOnTimeline={vi.fn()}
      />,
    );

    expect(document.querySelector("img")).toHaveAttribute("src", "thumb.jpg");
    expect(screen.getByTestId("composite-card")).toHaveStyle({
      opacity: "0.5",
      cursor: "grab",
    });
  });

  it("selects the card and isolates action button events", () => {
    const handlers = {
      onSelect: vi.fn(),
      onOpen: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onPlaceOnTimeline: vi.fn(),
    };
    render(
      <CompositeCard
        composite={composite()}
        isSelected={false}
        {...handlers}
      />,
    );

    fireEvent.click(screen.getByTestId("composite-card"));
    expect(handlers.onSelect).toHaveBeenCalledOnce();

    for (const [name, handler] of [
      ["Edit composite", handlers.onOpen],
      ["Place on timeline", handlers.onPlaceOnTimeline],
      ["Rename", handlers.onRename],
      ["Delete", handlers.onDelete],
    ] as const) {
      const menuButton = screen.getByRole("button", {
        name: "Composite actions",
      });
      fireEvent.mouseDown(menuButton);
      fireEvent.click(menuButton);
      fireEvent.click(screen.getByRole("menuitem", { name }));
      expect(handler).toHaveBeenCalledOnce();
    }
    expect(handlers.onSelect).toHaveBeenCalledOnce();
  });

  it("surfaces bake failure retry and only the force-live source override", () => {
    const retryCompositeBake = vi.fn(async () => true);
    useCompositeLibraryStore.setState({ retryCompositeBake });
    const failed = composite();
    failed.bake = {
      status: "failed",
      requestedKey: "key",
      error: "encoder failed",
    };
    render(
      <CompositeCard
        composite={failed}
        isSelected={false}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onPlaceOnTimeline={vi.fn()}
      />,
    );

    expect(screen.getByTestId("composite-bake-status")).toHaveTextContent(
      "Bake failed: encoder failed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Composite actions" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Retry background bake" }),
    );
    expect(retryCompositeBake).toHaveBeenCalledWith(failed.id);

    const forceLive = screen.getByRole("button", { name: "Force live rendering" });
    fireEvent.click(forceLive);
    expect(useCompositeRenderStatusStore.getState().forceLiveCompositeIds).toContain(
      failed.id,
    );
    expect(
      screen.queryByRole("button", { name: "Force baked rendering" }),
    ).not.toBeInTheDocument();
  });
  it("previews and exports the baked media while retaining editable timeline placement", () => {
    useAssetStore.setState({ assets: [bakedVideo] });
    const current = readyComposite();
    const onSelect = vi.fn();
    render(<CompositeCard composite={current} isSelected={false}
      onSelect={onSelect} onOpen={vi.fn()} onRename={vi.fn()}
      onDelete={vi.fn()} onPlaceOnTimeline={vi.fn()} />);
    const preview = screen.getByRole("button", { name: "Preview video" });
    fireEvent.pointerDown(preview);
    expect(mocks.draggable.listeners.onPointerDown).not.toHaveBeenCalled();
    fireEvent.click(preview);
    expect(onSelect).not.toHaveBeenCalled();
    expect(mocks.openPreview).toHaveBeenCalledWith(bakedVideo, {
      openerId: "composite-browser:composite-1",
    });
    fireEvent.doubleClick(screen.getByTestId("composite-card"));
    expect(mocks.openPreview).toHaveBeenCalledTimes(2);
    const { result } = renderHook(() => useAssetDrag());
    const onDrop = vi.fn();
    const dragConfig = mocks.useDraggable.mock.lastCall?.[0] as {
      data: { type: "asset"; asset: Asset };
    };
    act(() => {
      result.current.handleAssetDragEnd({
        active: { data: { current: dragConfig.data } },
        over: { data: { current: { type: "asset-slot", accept: ["video"], onDrop } } },
      } as unknown as DragEndEvent);
    });
    expect(onDrop).toHaveBeenCalledWith(bakedVideo, null);

    expect(mocks.useDraggable).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: "asset", asset: bakedVideo,
        clip: expect.objectContaining({ compositeId: current.id, compositeRevision: 2 }),
      }),
    }));
  });

  it.each(["queued", "rendering", "failed", "stale-revision", "stale-key", "missing-reference"])(
    "does not expose unavailable media (%s) to preview or asset slots", (state) => {
      useAssetStore.setState({ assets: [bakedVideo] });
      const current = readyComposite();
      current.bake = {
        ...current.bake!,
        status: state === "queued" || state === "rendering" || state === "failed" ? state : "ready",
        assetId: state === "missing-reference" ? undefined : bakedVideo.id,
        readyRevision: state === "stale-revision" ? 1 : 2,
        readyKey: state === "stale-key" ? "old" : current.bake!.readyKey,
      };
      renderCard(current);
      expectUnavailableMedia();
    },
  );

  it.each(["content", "fps", "dimensions", "dependency"])(
    "rejects a ready bake after %s changes with no rebake requested", (change) => {
      const source = { ...bakedVideo, id: "source-1", hash: "original" };
      useAssetStore.setState({ assets: [bakedVideo, source] });
      const current = readyComposite();
      if (change === "dependency") {
        current.content.clips = [{
          id: "source-clip", name: "Source", type: "video", assetId: source.id,
          trackId: "track-1", start: 0, timelineDuration: 100,
          sourceDuration: 100, croppedSourceDuration: 100, offset: 0,
          transformedDuration: 100, transformedOffset: 0, transformations: [],
        }];
        current.bake!.readyKey = bakeKey(current);
      }
      current.bake!.requestedKey = undefined;
      const { rerender } = renderCard(current);
      expect(screen.getByRole("button", { name: "Preview video" })).toBeInTheDocument();
      if (change === "content") {
        rerender(card({ ...current, content: { ...current.content, durationTicks: 999 } }));
      } else {
        act(() => {
          if (change === "dependency") {
            useAssetStore.setState({ assets: [bakedVideo, { ...source, hash: "changed" }] });
          } else {
            useProjectStore.setState({ config: {
              ...useProjectStore.getState().config,
              ...(change === "fps" ? { fps: 60 } : { aspectRatio: "1:1" as const }),
            } });
          }
        });
      }
      expectUnavailableMedia();
    },
  );
});

function bakeKey(value: CompositeAsset): string {
  const config = useProjectStore.getState().config;
  return serializeCompositeBakeKey(createCompositeBakeKey({
    content: value.content,
    projectFps: config.fps,
    logicalDimensions: getProjectDimensions(config.aspectRatio),
    assets: useAssetStore.getState().assets,
  }));
}

function readyComposite(): CompositeAsset {
  const value = { ...composite(), revision: 2 };
  const key = bakeKey(value);
  return { ...value, bake: {
    status: "ready", assetId: bakedVideo.id, readyRevision: 2,
    requestedKey: key, readyKey: key,
  } };
}

function card(value: CompositeAsset) {
  return <CompositeCard composite={value} isSelected={false}
    onSelect={vi.fn()} onOpen={vi.fn()} onRename={vi.fn()}
    onDelete={vi.fn()} onPlaceOnTimeline={vi.fn()} />;
}

function renderCard(value: CompositeAsset) {
  return render(card(value));
}

function expectUnavailableMedia() {
  expect(screen.queryByRole("button", { name: "Preview video" })).not.toBeInTheDocument();
  fireEvent.doubleClick(screen.getByTestId("composite-card"));
  expect(mocks.openPreview).not.toHaveBeenCalled();
  // Inspect the latest payload: an earlier valid render must not satisfy this check.
  expect(mocks.useDraggable.mock.lastCall?.[0]).toEqual(expect.objectContaining({
    data: expect.objectContaining({ asset: undefined,
      clip: expect.objectContaining({ compositeId: "composite-1" }),
    }),
  }));
}
