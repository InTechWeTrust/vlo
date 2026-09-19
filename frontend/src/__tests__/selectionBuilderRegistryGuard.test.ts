import { describe, expect, it } from "vitest";

/**
 * Ratchet: every place that builds a `TimelineSelection` is registered, and
 * every one that captures from a live timeline is covered by the selection
 * builder contract.
 *
 * A selection renders detached, from its own clips and tracks. A builder that
 * takes the wrong clips — typically only the clips inside the range, dropping
 * the retiming adjustment ahead of it that places them — produces a selection
 * that renders the wrong frames, and no expression in the code looks wrong.
 * Pattern guards cannot see that omission; the contract test
 * (`timelineSelection/utils/__tests__/selectionBuilderContract.test.ts`) can,
 * by running each capture builder against retiming scenarios. This guard makes
 * sure no builder escapes it.
 *
 * Detection: a production object literal with a top-level `clips` key and
 * either a `start` key or a spread of a selection (`...selection`,
 * `...value.selection`) — the shape of building or re-clipping a selection.
 * The options object of `collectTimelineRegionClips(...)` shares the shape and
 * is skipped.
 *
 * When this fails:
 * - a new file / literal that captures clips from a timeline → register it as
 *   `capture`, route it through a contract symbol (usually
 *   `collectTimelineRegionClips` / `getTimelineSelectionClips`), and make sure
 *   that symbol is a `builder:` in the contract test;
 * - one that derives from an existing selection, or is self-contained → register
 *   it with the role and a reason;
 * - a count went down → lower it.
 */

const RAW_FILES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const CONTRACT_TEST = Object.values(
  import.meta.glob(
    "../features/timelineSelection/utils/__tests__/selectionBuilderContract.test.ts",
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>,
)[0];

type Role =
  /** Takes clips from a live timeline: must be covered by the contract. */
  | "capture"
  /** Re-shapes an existing selection's clips (narrow, edit, repair, sync). */
  | "derive"
  /** Its clips are the whole of what it renders (synthetic, local, full timeline). */
  | "self-contained"
  /** Carries no clips (placeholders). */
  | "placeholder";

interface Entry {
  /** Selection-shaped literals in the file, by role. */
  literals: Partial<Record<Role, number>>;
  /** For `capture`: the contract symbols the file routes through. */
  contracts?: string[];
  reason: string;
}

const REGISTRY: Record<string, Entry> = {
  "features/timelineSelection/utils/createTimelineSelection.ts": {
    literals: { capture: 3 },
    contracts: [
      "createTimelineSelection",
      "createPointTimelineSelection",
      "createTimelineSelectionFromClipIds",
    ],
    reason: "The store-backed selection builders.",
  },
  "features/renderer/hooks/useExportJobController.ts": {
    literals: { capture: 1, "self-contained": 1 },
    contracts: ["collectTimelineRegionClips"],
    reason: "Range export captures; project export passes the whole timeline.",
  },
  "app/e2e/selectionExportProbe.ts": {
    literals: { capture: 1 },
    contracts: ["collectTimelineRegionClips"],
    reason: "E2E export probe over a range of the live timeline.",
  },
  "features/composite/services/groupSelectionIntoComposite.ts": {
    literals: { capture: 1 },
    contracts: ["selectionToCompositeContent"],
    reason:
      "Captures the in-range clips and projects them to local time against the full timeline.",
  },
  "features/generation/utils/miniEditorEdit.ts": {
    literals: { derive: 2, "self-contained": 1 },
    reason:
      "Narrows/edits a captured selection; the asset path renders one synthetic clip.",
  },
  "features/masks/runtime/brushAssetSync.ts": {
    literals: { derive: 1 },
    reason: "Rewrites a selection's brush-mask clips in place.",
  },
  "features/generation/pipeline/generationPlan.ts": {
    literals: { derive: 1 },
    reason: "Copies a selection's clips into the plan.",
  },
  "features/timelineSelection/utils/timelineSelection.ts": {
    literals: { derive: 2 },
    reason: "Normalization / legacy repair of saved selections.",
  },
  "features/timelineSelection/utils/composite.ts": {
    literals: { "self-contained": 1 },
    reason: "Composite content is already local and complete.",
  },
  "features/timeline/utils/clipAudioExtraction.ts": {
    literals: { "self-contained": 1 },
    reason: "Deliberately extracts one clip's own audio, without adjustments.",
  },
  "features/generation/utils/inputSelection.ts": {
    literals: { "self-contained": 1 },
    reason: "Renders one synthetic asset clip.",
  },
  "features/renderer/services/ExportRenderer.ts": {
    literals: { "self-contained": 1 },
    reason: "Default selection: the whole project.",
  },
  "features/generation/hooks/useGenerationPanel.ts": {
    literals: { placeholder: 2 },
    reason: "Audio placeholders with no clips.",
  },
};

function normalize(globKey: string): string {
  return globKey.replace(/^\.\.\//, "");
}

function isProductionSource(path: string): boolean {
  return !path.includes("__tests__") && !path.includes(".test.");
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

function topLevelParts(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if ("{[(".includes(char)) depth += 1;
    else if ("}])".includes(char)) depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/** Counts selection-shaped object literals in stripped source. */
function countSelectionLiterals(source: string): number {
  const open: number[] = [];
  let count = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      open.push(index);
      continue;
    }
    if (char !== "}" || open.length === 0) continue;
    const start = open.pop()!;
    if (/collectTimelineRegionClips\s*\(\s*$/.test(source.slice(0, start))) {
      continue;
    }
    const parts = topLevelParts(source.slice(start + 1, index));
    const keys = new Set<string>();
    let spreadsSelection = false;
    for (const part of parts) {
      const spread = /^\s*\.\.\.\s*([\w$.]+)/.exec(part);
      if (spread) {
        if (/selection/i.test(spread[1])) spreadsSelection = true;
        continue;
      }
      const key = /^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(part);
      if (key) keys.add(key[1]);
    }
    if (keys.has("clips") && (keys.has("start") || spreadsSelection)) count += 1;
  }
  return count;
}

describe("selection builder registry guard", () => {
  it("registers every selection-building file with its literal count", () => {
    const actual: Record<string, number> = {};
    for (const [globKey, source] of Object.entries(RAW_FILES)) {
      const path = normalize(globKey);
      if (!isProductionSource(path)) continue;
      const count = countSelectionLiterals(stripCommentsAndStrings(source));
      if (count > 0) actual[path] = count;
    }
    const registered = Object.fromEntries(
      Object.entries(REGISTRY).map(([path, entry]) => [
        path,
        Object.values(entry.literals).reduce((sum, n) => sum + (n ?? 0), 0),
      ]),
    );

    expect(
      actual,
      "Selection-building literals changed: register them (see the header)",
    ).toEqual(registered);
  });

  it("covers every capture builder with the selection builder contract", () => {
    const uncovered: string[] = [];
    for (const [path, entry] of Object.entries(REGISTRY)) {
      if (!entry.literals.capture) continue;
      const contracts = entry.contracts ?? [];
      if (contracts.length === 0) uncovered.push(`${path}: no contract symbol`);
      const source = stripCommentsAndStrings(RAW_FILES[`../${path}`] ?? "");
      for (const symbol of contracts) {
        if (!new RegExp(`\\b${symbol}\\s*\\(`).test(source)) {
          uncovered.push(`${path}: does not call ${symbol}`);
        }
        if (!CONTRACT_TEST.includes(`builder: "${symbol}"`)) {
          uncovered.push(`${path}: ${symbol} is not a builder in the contract test`);
        }
      }
    }
    expect(uncovered).toEqual([]);
  });
});
