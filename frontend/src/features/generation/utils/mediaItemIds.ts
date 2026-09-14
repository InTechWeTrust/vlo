import type { GenerationMediaInputValue } from "../types";

/**
 * Occurrence identity for attached generation media
 * (docs/minimax-ref2v-prompt-composer-plan.md §3.1).
 *
 * A slot id is an *address* — positional, renumbered whenever a batch repacks.
 * An item id names one *attachment*: it is minted when media is attached and
 * then rides the value through every move, compaction, option change and
 * preparation rewrite, so something that refers to "the second reference
 * image" can keep referring to it after the batch is reordered.
 *
 * It is not an asset id. The same asset attached twice is two occurrences with
 * two ids, and replacing a slot's media mints a new one — a reference to the
 * old occupant must go unresolved rather than silently point at its successor.
 */

/** Generous for a UUID with a prefix, small enough to be obviously an id. */
const MAX_MEDIA_ITEM_ID_LENGTH = 128;
const MEDIA_ITEM_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export function createMediaItemId(): string {
  return `media-${crypto.randomUUID()}`;
}

export function isValidMediaItemId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_MEDIA_ITEM_ID_LENGTH &&
    MEDIA_ITEM_ID_PATTERN.test(value)
  );
}

/**
 * Ids for values that were written without one.
 *
 * Every store action mints an id, so this only covers values placed in state
 * directly — fixtures, and state restored by code that predates identity.
 * Keyed by object so the answer is stable while the value is unchanged, which
 * is the most that can honestly be said about a value nobody named.
 */
const unnamedValueIds = new WeakMap<GenerationMediaInputValue, string>();

export function readMediaItemId(value: GenerationMediaInputValue): string {
  if (isValidMediaItemId(value.itemId)) return value.itemId;
  let id = unnamedValueIds.get(value);
  if (!id) {
    id = createMediaItemId();
    unnamedValueIds.set(value, id);
  }
  return id;
}

/** Every occurrence id currently held across a panel's media inputs. */
export function collectMediaItemIds(
  mediaInputs: Readonly<Record<string, GenerationMediaInputValue | null>>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const value of Object.values(mediaInputs)) {
    if (value && isValidMediaItemId(value.itemId)) ids.add(value.itemId);
  }
  return ids;
}
