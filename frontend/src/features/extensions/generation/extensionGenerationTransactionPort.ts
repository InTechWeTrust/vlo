import { serializeFiniteJson } from "../../generation/utils/finiteJson";
import type { ExtensionGenerationTransaction } from "../types";
import type { GenerationSessionTransaction } from "../../generation/services/generationSessionTypes";

/**
 * The owner-bound transaction an extension is handed.
 *
 * Every write crosses this boundary rather than reaching the session directly:
 * ids and values are bounded here, and a violation throws inside the host's
 * transaction so the whole batch rolls back with a translated failure instead
 * of a raw store error escaping to package code.
 *
 * Shared so every surface that lets an extension write — `api.generation
 * .transaction`, and the staged inputs editor's `additionalWrites` — hands
 * over the *same* port. A second construction would be a second, quietly
 * different, contract.
 */

const MAX_TEXT_VALUE_LENGTH = 1_000_000;
const MAX_TARGET_PART_LENGTH = 512;
/**
 * A widget write is a scalar or a small structure, never a payload: the panel's
 * own controls emit strings, numbers, and booleans. Bounding it here keeps an
 * extension from making the host validate — and the graph bridge apply — an
 * arbitrarily large blob.
 */
const MAX_WIDGET_VALUE_LENGTH = 100_000;
/**
 * Comfortably above any batch the panel can hold, and low enough that an
 * ordinal is obviously a position rather than a number smuggled in.
 */
const MAX_MEDIA_ORDINAL = 10_000;
/** The host declares a handful of per-item switches, not an open dictionary. */
const MAX_ITEM_OPTIONS = 32;
/** A sentence for the user beside the box, not a document. */
function boundedId(value: unknown, what: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_TARGET_PART_LENGTH
  ) {
    throw new Error(
      `${what} must be non-empty strings of at most ${MAX_TARGET_PART_LENGTH} characters.`,
    );
  }
  return value;
}

/**
 * A delivery position, not an arbitrary number: bounded here so a huge or
 * fractional ordinal is refused as malformed input rather than travelling on
 * to be reported as out of range, which would read as a batch-size problem.
 */
function boundedOrdinal(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_MEDIA_ORDINAL
  ) {
    throw new Error(
      `Generation media ordinals must be whole numbers from 0 to ${MAX_MEDIA_ORDINAL}.`,
    );
  }
  return value;
}

export function createExtensionTransactionPort(
  session: GenerationSessionTransaction,
): ExtensionGenerationTransaction {
  return {
  setTextInput: (inputId, value) => {
    if (typeof inputId !== "string" || inputId.trim().length === 0) {
      throw new Error(
        "Generation input IDs must be non-empty strings.",
      );
    }
    if (
      typeof value !== "string" ||
      value.length > MAX_TEXT_VALUE_LENGTH ||
      serializeFiniteJson(value) === null
    ) {
      throw new Error(
        `Generation text values must contain at most ${MAX_TEXT_VALUE_LENGTH} characters.`,
      );
    }
    session.setTextInput(inputId, value);
  },
  setWidget: (target, value) => {
    const nodeId =
      typeof target?.nodeId === "string" ? target.nodeId : "";
    const widget =
      typeof target?.widget === "string" ? target.widget : "";
    if (
      nodeId.trim().length === 0 ||
      widget.trim().length === 0 ||
      nodeId.length > MAX_TARGET_PART_LENGTH ||
      widget.length > MAX_TARGET_PART_LENGTH
    ) {
      throw new Error(
        `Generation widget targets need a node id and a widget name of at most ${MAX_TARGET_PART_LENGTH} characters.`,
      );
    }
    // Finite JSON and bounded *before* the host sees it. The host
    // validates the value against the widget; the adapter validates
    // that it is a value at all, because an SDK caller is untrusted
    // input and a native control is not.
    const serialized = serializeFiniteJson(value);
    if (
      serialized === null ||
      serialized.length > MAX_WIDGET_VALUE_LENGTH
    ) {
      throw new Error(
        `Generation widget values must be finite JSON of at most ${MAX_WIDGET_VALUE_LENGTH} serialized characters.`,
      );
    }
    session.setWidget(
      { nodeId, widget },
      JSON.parse(serialized) as unknown,
    );
  },
  // Media writes carry no payload — an id, a position, a boolean —
  // so the adapter's job is bounding the identifiers and refusing
  // anything that is not a whole number. What a slot will actually
  // accept is the host's, judged against the drop rules.
  attachAsset: (inputId, assetId, options) => {
    const itemOptions = options?.itemOptions;
    if (itemOptions !== undefined) {
      const entries = Object.entries(itemOptions);
      if (entries.length > MAX_ITEM_OPTIONS) {
        throw new Error(
          `An attach may set at most ${MAX_ITEM_OPTIONS} item options.`,
        );
      }
      for (const [optionId, value] of entries) {
        boundedId(optionId, "Generation option IDs");
        if (typeof value !== "boolean") {
          throw new Error(
            "Generation media options take boolean values.",
          );
        }
      }
    }
    session.attachAsset(
      boundedId(inputId, "Generation input IDs"),
      boundedId(assetId, "Asset IDs"),
      {
        ...(options?.at === undefined
          ? {}
          : { at: boundedOrdinal(options.at) }),
        ...(itemOptions === undefined ? {} : { itemOptions }),
      },
    );
  },
  moveMedia: (inputId, fromOrdinal, toOrdinal) => {
    session.moveMedia(
      boundedId(inputId, "Generation input IDs"),
      boundedOrdinal(fromOrdinal),
      boundedOrdinal(toOrdinal),
    );
  },
  removeMedia: (inputId, slotId) => {
    session.removeMedia(
      boundedId(inputId, "Generation input IDs"),
      boundedId(slotId, "Generation slot IDs"),
    );
  },
  setMediaOption: (slotId, optionId, value) => {
    if (typeof value !== "boolean") {
      throw new Error(
        "Generation media options take boolean values.",
      );
    }
    session.setMediaOption(
      boundedId(slotId, "Generation slot IDs"),
      boundedId(optionId, "Generation option IDs"),
      value,
    );
  },
  };
}
