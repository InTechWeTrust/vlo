import {
  expandCubeLutTo3d,
  parseCubeLut,
  type CubeLut,
} from "../../../../../core/color";

/**
 * Per-asset `.cube` cache feeding the fused grade's LUT atlas. Loads are
 * asynchronous (asset file → parse → 3D expansion); `getLoadedCubeLut` returns
 * synchronously with whatever is cached and kicks off a load on first miss,
 * and load completions notify subscribers so the filter can rebake + rerender.
 */

type CubeLutTextSource = (assetId: string) => Promise<string | null>;

const defaultTextSource: CubeLutTextSource = async (assetId) => {
  // Lazy import keeps the render-side module graph free of the userAssets
  // feature (and its UI) at load time.
  const { ensureAssetSourceLoaded } = await import("../../../../userAssets");
  const asset = await ensureAssetSourceLoaded(assetId);
  if (!asset) return null;
  if (asset.file) return asset.file.text();
  // A detached render host binds assets to URLs; it has no editor File.
  if (/^(blob:|https?:)/.test(asset.src)) {
    const response = await fetch(asset.src);
    if (!response.ok) throw new Error(`LUT request failed: ${response.status}`);
    return response.text();
  }
  return null;
};

let cubeLutTextSource = defaultTextSource;

interface CubeLutCacheEntry {
  status: "loading" | "loaded" | "error";
  lut: CubeLut | null;
  promise: Promise<CubeLut | null>;
}

const cubeLutCache = new Map<string, CubeLutCacheEntry>();
const loadListeners = new Set<() => void>();

export function subscribeCubeLutLoads(listener: () => void): () => void {
  loadListeners.add(listener);
  return () => {
    loadListeners.delete(listener);
  };
}

async function loadCubeLut(assetId: string): Promise<CubeLut | null> {
  let lut: CubeLut | null = null;
  try {
    const text = await cubeLutTextSource(assetId);
    if (text !== null) lut = expandCubeLutTo3d(parseCubeLut(text));
  } catch (error) {
    console.warn(`[ColorGrade] Failed to load LUT asset ${assetId}`, error);
  }
  const entry = cubeLutCache.get(assetId);
  if (entry) {
    entry.status = lut ? "loaded" : "error";
    entry.lut = lut;
  }
  if (lut) loadListeners.forEach((listener) => listener());
  return lut;
}

function ensureCubeLutEntry(assetId: string): CubeLutCacheEntry {
  const existing = cubeLutCache.get(assetId);
  if (existing) return existing;
  const entry: CubeLutCacheEntry = {
    status: "loading",
    lut: null,
    promise: Promise.resolve(null),
  };
  cubeLutCache.set(assetId, entry);
  entry.promise = loadCubeLut(assetId);
  return entry;
}

/** Sync lookup for the render path; starts an async load on first miss. */
export function getLoadedCubeLut(assetId: string): CubeLut | null {
  return ensureCubeLutEntry(assetId).lut;
}

/** Awaitable lookup for one-off consumers (grade → .cube export). */
export async function getCubeLutForAsset(
  assetId: string,
): Promise<CubeLut | null> {
  return ensureCubeLutEntry(assetId).promise;
}

export function setCubeLutTextSourceForTests(
  source: CubeLutTextSource | null,
): void {
  cubeLutTextSource = source ?? defaultTextSource;
  cubeLutCache.clear();
}

interface ClipTransformLike {
  readonly type: string;
  readonly isEnabled?: boolean;
  readonly filterName?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export class ColorGradeLutUnavailableError extends Error {
  readonly assetId: string;
  constructor(assetId: string) {
    super(`The LUT used by a Color Grade (asset ${assetId}) could not be loaded or parsed, so the export would not match the grade.`);
    this.name = "ColorGradeLutUnavailableError";
    this.assetId = assetId;
  }
}

/**
 * Awaits every `.cube` referenced by the clips' enabled Color Grade
 * transforms so strict (export) rendering never emits early frames with a
 * still-loading LUT.
 *
 * With `strict`, a LUT that cannot be loaded or parsed fails the render: an
 * export must not quietly become an ungraded one. A previously failed load is
 * retried once first, since the file may have been restored since. Without
 * it, failures render as pass-through, matching the live path.
 */
export async function preloadColorGradeLuts(
  clips: readonly {
    readonly transformations?: readonly ClipTransformLike[];
  }[],
  options: { strict?: boolean } = {},
): Promise<void> {
  const { COLOR_GRADE_FILTER_NAME } = await import("./definition");
  const assetIds = new Set<string>();
  for (const clip of clips) {
    for (const transform of clip.transformations ?? []) {
      if (
        transform.type !== "filter" ||
        transform.isEnabled === false ||
        transform.filterName !== COLOR_GRADE_FILTER_NAME
      ) {
        continue;
      }
      const assetId = transform.parameters?.lutAssetId;
      if (typeof assetId === "string" && assetId.length > 0) {
        assetIds.add(assetId);
      }
    }
  }
  await Promise.all([...assetIds].map(async (assetId) => {
    if (options.strict && cubeLutCache.get(assetId)?.status === "error") {
      cubeLutCache.delete(assetId);
    }
    const lut = await getCubeLutForAsset(assetId);
    if (!lut && options.strict) throw new ColorGradeLutUnavailableError(assetId);
  }));
}

// === 2D-atlas layout ===
//
// A 3D LUT of size N is stored as N slices (fixed blue index) of N×N texels
// (red → x, green → y), tiled into a near-square grid so a 65³ LUT stays far
// below GL texture limits. Multiple grades stack their grids vertically in
// one shared rgba32float texture; each grade addresses its region via
// (size, tilesX, rowOffset) written to the parameter texture.

export interface CubeLutAtlasTile {
  readonly lut: CubeLut;
  readonly size: number;
  readonly tilesX: number;
  readonly rowOffset: number;
}

export interface CubeLutAtlasPlan {
  readonly tiles: readonly (CubeLutAtlasTile | null)[];
  readonly width: number;
  readonly height: number;
}

export function planCubeLutAtlas(
  luts: readonly (CubeLut | null)[],
): CubeLutAtlasPlan {
  const tiles: (CubeLutAtlasTile | null)[] = [];
  let width = 1;
  let height = 0;
  for (const lut of luts) {
    if (!lut) {
      tiles.push(null);
      continue;
    }
    const tilesX = Math.ceil(Math.sqrt(lut.size));
    const tilesY = Math.ceil(lut.size / tilesX);
    tiles.push({ lut, size: lut.size, tilesX, rowOffset: height });
    width = Math.max(width, tilesX * lut.size);
    height += tilesY * lut.size;
  }
  return { tiles, width, height: Math.max(1, height) };
}

export function writeCubeLutAtlas(plan: CubeLutAtlasPlan): Float32Array<ArrayBuffer> {
  const pixels = new Float32Array(plan.width * plan.height * 4);
  for (const tile of plan.tiles) {
    if (!tile) continue;
    const { lut, size, tilesX, rowOffset } = tile;
    let dataOffset = 0;
    for (let b = 0; b < size; b += 1) {
      const tileX = (b % tilesX) * size;
      const tileY = rowOffset + Math.floor(b / tilesX) * size;
      for (let g = 0; g < size; g += 1) {
        let pixelOffset = ((tileY + g) * plan.width + tileX) * 4;
        for (let r = 0; r < size; r += 1) {
          pixels[pixelOffset] = lut.data[dataOffset];
          pixels[pixelOffset + 1] = lut.data[dataOffset + 1];
          pixels[pixelOffset + 2] = lut.data[dataOffset + 2];
          pixels[pixelOffset + 3] = 1;
          dataOffset += 3;
          pixelOffset += 4;
        }
      }
    }
  }
  return pixels;
}
