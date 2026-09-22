import { afterEach, describe, expect, it, vi } from "vitest";
import { useAssetStore } from "../../../userAssets";
import type { RenderResult } from "../../services/ExportRenderer";
import type { DetachedProjectRender } from "../projectRenderBootstrap";

const { renderProjectToOutput } = vi.hoisted(() => ({ renderProjectToOutput: vi.fn() }));
vi.mock("../../services/renderProjectToOutput", () => ({ renderProjectToOutput }));

import { runDetachedProjectRender } from "../runDetachedProjectRender";

const render = {
  exportConfig: { logicalWidth: 1920, logicalHeight: 1080, outputWidth: 320, outputHeight: 180, backgroundAlpha: 1 },
  projectData: {
    tracks: [], clips: [], transitions: [], duration: 3200, fps: 30,
    assets: [{ id: "movie", hash: "movie", name: "m.mp4", type: "video", src: "blob:http://host.test/movie", createdAt: 0, duration: 1 }],
  },
  format: "mp4", keyFrameInterval: 1, includeAudio: false,
} as unknown as DetachedProjectRender;

afterEach(() => {
  useAssetStore.setState({ assets: [], inputCache: new Map() });
  renderProjectToOutput.mockReset();
});

describe("runDetachedProjectRender", () => {
  it("renders with the document's assets installed and its encoding applied", async () => {
    renderProjectToOutput.mockImplementation(async () => {
      expect(useAssetStore.getState().assets.map(({ id }) => id)).toEqual(["movie"]);
      return { outputs: {} } as RenderResult;
    });
    await runDetachedProjectRender(render);
    expect(renderProjectToOutput).toHaveBeenCalledWith(expect.objectContaining({
      projectData: render.projectData, format: "mp4", keyFrameInterval: 1, includeAudio: false,
      exportConfig: render.exportConfig,
    }));
    expect(useAssetStore.getState().assets).toEqual([]);
  });

  it("tears the asset runtime down when the render fails", async () => {
    renderProjectToOutput.mockRejectedValue(new Error("encoder lost"));
    await expect(runDetachedProjectRender(render)).rejects.toThrow("encoder lost");
    expect(useAssetStore.getState().assets).toEqual([]);
  });
});
