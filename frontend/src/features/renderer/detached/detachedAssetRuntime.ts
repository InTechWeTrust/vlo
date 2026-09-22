import type { Input } from "mediabunny";
import { useAssetStore } from "../../userAssets";
import type { Asset } from "../../../types/Asset";

export class DetachedAssetRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetachedAssetRuntimeError";
  }
}

/**
 * Makes a detached realm's asset library the render's assets, for as long as
 * the render runs.
 *
 * Decoders, mask sources and the audio mixer still find media through the
 * userAssets store by ID, so a fresh realm, whose store is empty, would fail
 * its first frame. The bootstrapped assets already carry host-owned URLs,
 * which the store treats as hydrated, so nothing here reads a project folder.
 *
 * Refuses a store that already holds assets: that is the editor's library,
 * and replacing it would lose the user's work. The returned disposer empties
 * the store and closes the inputs the render opened. It leaves the asset URLs
 * alone, because the host minted them and revokes them itself.
 */
export function installDetachedAssetRuntime(assets: readonly Asset[]): () => void {
  const state = useAssetStore.getState();
  if (state.assets.length > 0 || state.inputCache.size > 0) {
    throw new DetachedAssetRuntimeError(
      "A detached render needs a realm of its own; this one already has an asset library.",
    );
  }
  const inputCache = new Map<string, Input>();
  useAssetStore.setState({ assets: [...assets], inputCache });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    // The store may have swapped in a new cache map meanwhile; close both.
    const inputs = new Set([...inputCache.values(), ...useAssetStore.getState().inputCache.values()]);
    for (const input of inputs) input.dispose();
    useAssetStore.setState({ assets: [], inputCache: new Map() });
  };
}
