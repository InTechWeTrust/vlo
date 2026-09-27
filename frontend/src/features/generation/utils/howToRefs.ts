/**
 * Resolves image/link refs found in workflow how-to markdown.
 *
 * Refs are confined to the document's own bundle (relative paths) or the
 * shared libraries (`shared:` prefix). Remote URLs are only ever linked, never
 * embedded, and every other scheme (`javascript:`, `data:`, `file:`...) is
 * refused. The backend re-checks confinement; this keeps the UI from ever
 * requesting something it would refuse.
 */
import { howToAnchorTargetId } from "./howToHeadings";

export type HowToRefTarget =
  | { kind: "asset"; url: string; isVideo: boolean }
  | { kind: "external"; url: string }
  | { kind: "anchor"; url: string; targetId: string }
  | { kind: "unresolved"; ref: string };

export interface HowToAssetUrls {
  bundleAsset: (path: string) => string;
  sharedAsset: (path: string) => string;
}

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;
const VIDEO_EXTENSIONS = [".mp4", ".webm"];
const EXTERNAL_SCHEMES = new Set(["http", "https", "mailto"]);

/**
 * Joins `ref` onto `dir` and normalises `.`/`..`. Returns a decoded path, or
 * null when the result would leave the root or touch a hidden or empty
 * segment.
 *
 * Markdown hands refs over percent-encoded (`my shot.png` arrives as
 * `my%20shot.png`), so each segment is decoded once here and the URL
 * builders encode it once. `dir` comes from the backend already decoded.
 */
function joinConfined(dir: string, ref: string): string | null {
  if (ref.includes("\\") || ref.startsWith("/")) return null;
  const segments: string[] = dir ? dir.split("/").filter(Boolean) : [];
  for (const rawSegment of ref.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    // 1. An encoded separator or NUL must not smuggle in extra segments.
    if (/[/\\\0]/.test(segment)) return null;
    if (segment === ".") continue;
    if (segment === "..") {
      // 2. Popping past the root would escape the bundle or library.
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    // 3. Empty and hidden segments are refused, matching the backend.
    if (segment === "" || segment.startsWith(".")) return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

function stripQueryAndHash(ref: string): string {
  const cut = ref.search(/[?#]/);
  return cut === -1 ? ref : ref.slice(0, cut);
}

function assetTarget(url: string, path: string): HowToRefTarget {
  const lowered = path.toLowerCase();
  return {
    kind: "asset",
    url,
    isVideo: VIDEO_EXTENSIONS.some((extension) => lowered.endsWith(extension)),
  };
}

export function resolveHowToRef(
  rawRef: string | undefined,
  base: string | null,
  urls: HowToAssetUrls,
): HowToRefTarget {
  const ref = (rawRef ?? "").trim();
  if (!ref) return { kind: "unresolved", ref };
  if (ref.startsWith("#")) {
    const targetId = howToAnchorTargetId(ref);
    return targetId
      ? { kind: "anchor", url: ref, targetId }
      : { kind: "unresolved", ref };
  }

  const scheme = SCHEME_PATTERN.exec(ref)?.[1]?.toLowerCase();
  if (scheme === "shared") {
    const path = joinConfined("", stripQueryAndHash(ref.slice("shared:".length)));
    return path
      ? assetTarget(urls.sharedAsset(path), path)
      : { kind: "unresolved", ref };
  }
  if (scheme !== undefined) {
    return EXTERNAL_SCHEMES.has(scheme)
      ? { kind: "external", url: ref }
      : { kind: "unresolved", ref };
  }

  // Relative ref: resolve against the fragment's own bundle or library.
  const relative = stripQueryAndHash(ref);
  if (base?.startsWith("bundle:")) {
    const path = joinConfined(base.slice("bundle:".length), relative);
    return path
      ? assetTarget(urls.bundleAsset(path), path)
      : { kind: "unresolved", ref };
  }
  if (base?.startsWith("shared:")) {
    const path = joinConfined(base.slice("shared:".length), relative);
    return path
      ? assetTarget(urls.sharedAsset(path), path)
      : { kind: "unresolved", ref };
  }
  return { kind: "unresolved", ref };
}
