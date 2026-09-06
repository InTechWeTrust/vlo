import { generationSessionService } from "../../generation/services/GenerationSessionService";
import { generationTextInputClaims } from "../../generation/services/GenerationTextInputClaims";
import { validateTextInputCommand } from "../../generation/services/generationSessionValidation";
import { serializeFiniteJson } from "../../generation/utils/finiteJson";
import type { RevisionSource } from "../../../core/shell/revisionRelay";
import type {
  GenerationTransactionResult,
  GenerationTransactionFailureCode,
} from "../../generation/services/generationSessionTypes";
import { bindOwnerScopedSubscribe } from "../utils/ownerScopedSubscribe";
import { extensionGenerationSubmissionContributors } from "./ExtensionGenerationSubmissionContributors";
import { registerExtensionGenerationSection } from "./ExtensionGenerationPanelSections";
import { projectGenerationSession } from "./generationSessionProjection";
import type {
  ExtensionApiScope,
  ExtensionGenerationApi,
  ExtensionGenerationClaimResult,
  ExtensionGenerationRegistration,
  ExtensionGenerationSectionDefinition,
  ExtensionGenerationSessionSnapshot,
  ExtensionGenerationTransaction,
  ExtensionGenerationTransactionResult,
} from "../types";

/**
 * The extension adapter over the generation session
 * (docs/generation-native-extension-seams-plan.md §4,
 * docs/generation-extension-surface-plan.md E1).
 *
 * Everything owner-specific lives here: activation scope, SDK size limits,
 * finite-JSON checks on untrusted input, defensive cloning, and translation of
 * the host's failure codes into the public ones. The staging, validation, and
 * atomic commit are the generation feature's, shared with the native panel.
 */

const MAX_LABEL_LENGTH = 120;
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
const MAX_CLAIM_REASON_LENGTH = 300;

/**
 * The session's own change signal. The service is already payload-free and
 * revision-based, so it is a `RevisionSource` as it stands; the adapter only
 * adds owner scoping around it.
 */
const generationSessionSignal: RevisionSource = Object.freeze({
  subscribe: (listener: () => void) =>
    generationSessionService.subscribe(listener),
  getRevision: () => generationSessionService.getRevision(),
});

type PublicFailureCode = Exclude<
  ExtensionGenerationTransactionResult,
  { readonly ok: true }
>["code"];

/**
 * Host failure code → published failure code.
 *
 * Codes the SDK does not publish collapse onto a published one, so an
 * adapter-side bug can never leak an unmodelled code to an extension. `Record`
 * over the host union makes a newly added host code a compile error here rather
 * than a runtime `undefined` on the wire.
 *
 * The three widget codes are published as themselves since E1: an extension
 * that cannot tell "no such widget" from "the panel exposes no control for it"
 * from "that value is out of range" has no way to decide whether to fall back,
 * and would have to guess by re-trying.
 *
 * Exported for the N3 boundary test, which pins every entry — the translation
 * is a published contract, not an implementation detail
 * (docs/generation-native-extension-seams-plan.md §5, N3).
 */
export const PUBLIC_FAILURE_CODES: Record<
  GenerationTransactionFailureCode,
  PublicFailureCode
> = {
  invalid_label: "invalid_label",
  unavailable: "unavailable",
  // A workflow switch under the callback leaves the session the extension
  // addressed unreachable, which is what `unavailable` means publicly.
  workflow_changed: "unavailable",
  invalid_command: "invalid_command",
  callback_failed: "callback_failed",
  input_not_found: "input_not_found",
  input_type_mismatch: "input_type_mismatch",
  widget_not_found: "widget_not_found",
  widget_not_editable: "widget_not_editable",
  widget_value_invalid: "widget_value_invalid",
  // Media codes are published as themselves: each names a different thing for
  // the caller to do — pick another slot, another asset, make room, or stop
  // offering a switch the panel does not — and collapsing them would leave an
  // extension retrying to find out which.
  input_not_repeatable: "input_not_repeatable",
  asset_not_found: "asset_not_found",
  asset_type_rejected: "asset_type_rejected",
  batch_full: "batch_full",
  ordinal_out_of_range: "ordinal_out_of_range",
  media_not_found: "media_not_found",
  input_busy: "input_busy",
  option_not_available: "option_not_available",
};

function failure(
  label: string,
  code: PublicFailureCode,
  message: string,
): ExtensionGenerationTransactionResult {
  return { ok: false, code, message, label };
}

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

function toPublicResult(
  result: GenerationTransactionResult,
): ExtensionGenerationTransactionResult {
  if (result.ok) {
    return { ok: true, changed: result.changed, label: result.label };
  }
  return failure(
    result.label,
    PUBLIC_FAILURE_CODES[result.code],
    result.message,
  );
}

export function createExtensionGenerationApi(
  scope: ExtensionApiScope,
): ExtensionGenerationApi {
  // Truncation is reported once per revision per owner: the projection is
  // memoized and shared, so reporting inside it would either say nothing after
  // the first owner asked, or say it again on every render.
  let reportedTruncationRevision: number | null = null;

  /**
   * The projected session, reporting whatever the limits dropped.
   *
   * Both read entry points go through here. `listInputs` returning the same
   * inputs by a shorter route was a real hazard: a media list is where
   * truncation does the most damage — a missing reference silently shifts
   * every ordinal after it — and that is exactly the caller that would have
   * been given it with no diagnostic.
   */
  const readSession = (): ExtensionGenerationSessionSnapshot | null => {
    if (scope.signal.aborted) return null;
    const snapshot = generationSessionService.getSnapshot();
    if (!snapshot) return null;
    const { session, truncations } = projectGenerationSession(snapshot);
    if (
      truncations.length > 0 &&
      reportedTruncationRevision !== snapshot.revision
    ) {
      reportedTruncationRevision = snapshot.revision;
      scope.report(
        "warning",
        "The generation session snapshot was truncated to its published limits.",
        truncations,
      );
    }
    return session;
  };

  const registerSubmissionContributor =
    extensionGenerationSubmissionContributors.bind(scope);

  const api: ExtensionGenerationApi = {
    ui: Object.freeze({
      registerSection: (definition: ExtensionGenerationSectionDefinition) =>
        registerExtensionGenerationSection(scope, definition),
    }),
    // Already detached and deeply frozen by the projection, so it is handed
    // over as it stands rather than re-cloned per call.
    listInputs: () => readSession()?.inputs ?? [],
    getSession: readSession,
    claimTextInput: (inputId, options) => {
      const claimFailure = (
        code: Exclude<
          ExtensionGenerationClaimResult,
          { readonly ok: true }
        >["code"],
        message: string,
      ): ExtensionGenerationClaimResult => ({ ok: false, code, message });

      if (scope.signal.aborted) {
        return claimFailure(
          "unavailable",
          "The extension activation has ended.",
        );
      }
      const reason =
        typeof options?.reason === "string" ? options.reason.trim() : "";
      if (reason.length === 0 || reason.length > MAX_CLAIM_REASON_LENGTH) {
        return claimFailure(
          "invalid_reason",
          `A claim reason must contain 1-${MAX_CLAIM_REASON_LENGTH} characters.`,
        );
      }
      const snapshot = generationSessionService.getSnapshot();
      if (!snapshot) {
        return claimFailure(
          "unavailable",
          "The generation panel is not mounted.",
        );
      }
      if (typeof inputId !== "string" || inputId.trim().length === 0) {
        return claimFailure(
          "input_not_found",
          "Generation input IDs must be non-empty strings.",
        );
      }
      // The transaction path's resolver, so a claim addresses an input by
      // exactly the ids a write to it would accept, alias included.
      const resolved = validateTextInputCommand(snapshot, inputId.trim());
      if (!resolved.ok) {
        return claimFailure(
          resolved.failure.code === "input_type_mismatch"
            ? "input_type_mismatch"
            : "input_not_found",
          resolved.failure.message,
        );
      }

      const onRevoked =
        typeof options.onRevoked === "function" ? options.onRevoked : undefined;
      const claimed = generationTextInputClaims.claim({
        inputId: resolved.value,
        reason,
        ownerLabel: scope.extension.id,
        ...(onRevoked
          ? {
              onRevoked: () => {
                // An extension callback is untrusted code on a user gesture:
                // a throw here must not take the panel's click handler with it.
                try {
                  onRevoked();
                } catch (error) {
                  scope.report(
                    "error",
                    "A text-input claim revocation handler threw.",
                    [error instanceof Error ? error.message : String(error)],
                  );
                }
              },
            }
          : {}),
      });
      if (!claimed.ok) {
        return claimFailure(claimed.code, claimed.message);
      }

      let released = false;
      const registration: ExtensionGenerationRegistration = {
        id: resolved.value,
        dispose: () => {
          if (released) return;
          released = true;
          claimed.registration.release();
        },
      };
      // Owned by the activation, so a claim can never outlive the extension
      // that took it and strand the box read-only.
      return { ok: true, registration: scope.own(registration) };
    },
    // Zero once the activation has ended, matching the empty reads above: a
    // component still mounted over a disposed API sees one stable value rather
    // than a session it can no longer read moving underneath it.
    getRevision: () =>
      scope.signal.aborted ? 0 : generationSessionService.getRevision(),
    subscribe: bindOwnerScopedSubscribe(
      scope,
      generationSessionSignal,
      "Generation session",
    ),
    registerSubmissionContributor,
    transaction: (label, callback) => {
      if (typeof label !== "string") {
        return failure("", "invalid_label", "Generation labels must be strings.");
      }
      const normalizedLabel = label.trim();
      if (
        normalizedLabel.length === 0 ||
        normalizedLabel.length > MAX_LABEL_LENGTH
      ) {
        return failure(
          normalizedLabel,
          "invalid_label",
          `Generation labels must contain 1-${MAX_LABEL_LENGTH} characters.`,
        );
      }
      if (scope.signal.aborted) {
        return failure(
          normalizedLabel,
          "unavailable",
          "The extension activation has ended.",
        );
      }
      if (!generationSessionService.getSnapshot()) {
        return failure(
          normalizedLabel,
          "unavailable",
          "The generation panel is not mounted.",
        );
      }

      return toPublicResult(
        generationSessionService.transaction(normalizedLabel, (session) => {
          const transaction: ExtensionGenerationTransaction = {
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
          // Returned so the session still sees an async callback and refuses
          // it; the SDK contract is synchronous.
          return callback(transaction);
        }),
      );
    },
  };
  return Object.freeze(api);
}
