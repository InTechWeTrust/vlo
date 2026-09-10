import { GenerationInputsDraftFields } from "../../generation";
import { useSyncExternalStore } from "react";
import { nativeDraftFor } from "./extensionGenerationInputsDraft";

export interface ExtensionGenerationDraftFieldsProps {
  /** A draft from `api.generation.createInputsDraft`. */
  readonly controller: unknown;
}

/**
 * The panel's own input fields, rendered over an extension's draft.
 *
 * Lives on `runtime` rather than `api` because it writes nothing itself: every
 * edit it makes goes through the controller it was handed, which is already
 * owner-bound. That division is the whole point of the split — the thing with a
 * lifetime is scoped, and the thing that merely draws is shared.
 *
 * The handle is resolved back to its native draft rather than adapted: the
 * fields consume host snapshots, and re-deriving them from the projected ones a
 * package sees would drop the grouping, the per-item options and the previews
 * the projection does not carry.
 */
export function ExtensionGenerationDraftFields({
  controller,
}: ExtensionGenerationDraftFieldsProps) {
  const native = nativeDraftFor(controller);
  // Subscribed here, not in the fields: they take a plain reading, so the
  // component that owns the subscription is the one that can re-render.
  const reading = useSyncExternalStore(
    native ? native.subscribe : noSubscribe,
    native ? native.getSnapshot : noSnapshot,
    native ? native.getSnapshot : noSnapshot,
  );
  if (!native) return null;
  return (
    <GenerationInputsDraftFields
      controller={{
        ...reading,
        commit: native.commit,
        revert: native.revert,
        stage: native.stage,
      }}
    />
  );
}

const noSubscribe = () => () => undefined;
const noSnapshot = () => null as never;
