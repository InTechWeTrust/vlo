import { afterEach, describe, expect, it, vi } from "vitest";
import type { Input } from "mediabunny";
import { useAssetStore } from "../../../userAssets";
import type { Asset } from "../../../../types/Asset";
import {
  DetachedAssetRuntimeError,
  installDetachedAssetRuntime,
} from "../detachedAssetRuntime";

const asset = (id: string): Asset => ({
  id, hash: id, name: `${id}.mp4`, type: "video", src: `blob:http://host.test/${id}`, createdAt: 0, duration: 1,
});

afterEach(() => {
  useAssetStore.setState({ assets: [], inputCache: new Map() });
});

describe("detached asset runtime", () => {
  it("serves the render's assets by ID without touching the project folder", async () => {
    const dispose = installDetachedAssetRuntime([asset("movie")]);
    // A host-owned blob URL counts as hydrated: no file read, same record.
    await expect(useAssetStore.getState().ensureAssetSourceLoaded("movie"))
      .resolves.toMatchObject({ id: "movie", src: "blob:http://host.test/movie" });
    dispose();
  });

  it("refuses to replace an editor's asset library", () => {
    useAssetStore.setState({ assets: [asset("library")] });
    expect(() => installDetachedAssetRuntime([asset("movie")])).toThrow(DetachedAssetRuntimeError);
    expect(useAssetStore.getState().assets.map(({ id }) => id)).toEqual(["library"]);
  });

  it("closes the inputs the render opened and empties the library, once", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const dispose = installDetachedAssetRuntime([asset("movie")]);
    const input = { dispose: vi.fn() } as unknown as Input;
    useAssetStore.getState().inputCache.set("movie", input);
    dispose();
    dispose();
    expect(input.dispose).toHaveBeenCalledOnce();
    expect(useAssetStore.getState().assets).toEqual([]);
    expect(useAssetStore.getState().inputCache.size).toBe(0);
    // The host minted the URLs and revokes them itself.
    expect(revoke).not.toHaveBeenCalled();
    revoke.mockRestore();
  });
});
