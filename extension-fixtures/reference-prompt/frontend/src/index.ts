import type {
  ExtensionGenerationDraftCommitReading,
  ExtensionGenerationInputSnapshot,
  ExtensionGenerationInputsDraft,
  ExtensionGenerationInputsDraftState,
  ExtensionGenerationSectionProps,
  ExtensionModule,
  ExtensionReactRuntime,
} from "@vlo/extension-sdk";

/**
 * A provider-neutral consumer of the staged inputs editor, media occurrence
 * identity and the draft commit reading
 * (docs/minimax-ref2v-prompt-composer-plan.md §3.4, the R0 fixture gate).
 *
 * It does what any reference-aware prompt tool must, and nothing
 * model-specific: prose cites the items of one media batch, each citation names
 * the item's `itemId` rather than its position, reordering the batch in the
 * draft renumbers every citation, and the prompt is resolved only inside the
 * commit — against the arrangement that commit writes.
 *
 * Deliberately without an inline editor. The host provides none (plan §3.3),
 * so the authored template is an ordinary textarea holding `{{ref:<itemId>}}`
 * markers, and a live preview shows what they resolve to. That keeps this
 * fixture about the contract rather than about contenteditable.
 */

interface ReactHooksRuntime extends ExtensionReactRuntime {
  useState<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void];
  useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void;
  useRef<T>(initial: T): { current: T };
  useSyncExternalStore<T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
  ): T;
}

const MARKER = /\{\{ref:([^}]+)\}\}/g;

/** The marker a citation of `itemId` is authored as. */
export function referenceMarker(itemId: string): string {
  return `{{ref:${itemId}}}`;
}

/** What each item is called at one arrangement, by occurrence id. */
export function referenceLabels(
  input: ExtensionGenerationInputSnapshot | undefined,
): ReadonlyMap<string, string> {
  return new Map(
    (input?.media ?? []).map((item, index) => [item.itemId, `[Ref ${index + 1}]`]),
  );
}

export type ResolvedPrompt =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly missing: readonly string[] };

/**
 * The plain prompt for a template against one arrangement.
 *
 * Refuses rather than guessing: a citation of an item that is no longer in the
 * batch has no honest number, and writing the next item's number in its place
 * would change what the prose says.
 */
export function resolveReferencePrompt(
  template: string,
  input: ExtensionGenerationInputSnapshot | undefined,
): ResolvedPrompt {
  const labels = referenceLabels(input);
  const missing = [
    ...new Set(
      [...template.matchAll(MARKER)]
        .map((match) => match[1])
        .filter((itemId) => !labels.has(itemId)),
    ),
  ];
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    text: template.replace(MARKER, (_, itemId: string) => labels.get(itemId) ?? ""),
  };
}

interface SectionConfig {
  readonly referenceInputId: string;
  readonly promptInputId: string;
}

function readConfig(config: ExtensionGenerationSectionProps["config"]): SectionConfig {
  return {
    referenceInputId:
      typeof config.referenceInputId === "string" ? config.referenceInputId : "",
    promptInputId: typeof config.promptInputId === "string" ? config.promptInputId : "",
  };
}

const noSubscribe = () => () => undefined;

export const activate: ExtensionModule["activate"] = (context) => {
  const React = context.api.runtime.react as ReactHooksRuntime;
  const { generation } = context.api;
  const h = React.createElement;

  function ReferencePromptSection({ config }: ExtensionGenerationSectionProps) {
    const { referenceInputId, promptInputId } = readConfig(config);
    const [draft, setDraft] = React.useState<ExtensionGenerationInputsDraft | null>(null);
    // Opened in an effect, never during render: StrictMode's replay would
    // dispose a render-time draft and a memo would never open another.
    React.useEffect(() => {
      const opened = generation.createInputsDraft({
        inputIds: [referenceInputId],
        // Held, not addressed: the prompt is written by the commit below, so it
        // must never also be offered as a field whose edit that replaces.
        holdInputIds: [promptInputId],
      });
      setDraft(opened);
      return () => opened?.dispose();
    }, [referenceInputId, promptInputId]);

    const state = React.useSyncExternalStore<ExtensionGenerationInputsDraftState | null>(
      draft ? draft.subscribe : noSubscribe,
      () => draft?.getState() ?? null,
    );
    const [template, setTemplate] = React.useState("");
    const [status, setStatus] = React.useState("");
    const holding = React.useRef(false);

    const batch = state?.inputs.find((input) => input.id === referenceInputId);
    const labels = referenceLabels(batch);
    const preview = resolveReferencePrompt(template, batch);

    const edit = (next: string) => {
      // The prompt is written only at commit, so hold it now: an edit made in
      // the panel meanwhile becomes a conflict rather than being overwritten.
      if (draft && !holding.current) {
        draft.stage({ kind: "holdText", inputId: promptInputId });
        holding.current = true;
      }
      setTemplate(next);
    };

    const commit = () => {
      if (!draft) return;
      let refusal: string | null = null;
      const result = draft.commit(
        "Compose reference prompt",
        (transaction, reading: ExtensionGenerationDraftCommitReading) => {
          const resolved = resolveReferencePrompt(
            template,
            reading.inputs.find((input) => input.id === referenceInputId),
          );
          if (!resolved.ok) {
            refusal = `${resolved.missing.length} reference(s) no longer resolve.`;
            // Thrown so the staged media rolls back with the text.
            throw new Error(refusal);
          }
          transaction.setTextInput(promptInputId, resolved.text);
        },
      );
      if (result.ok) {
        holding.current = false;
        setStatus("Committed.");
      } else {
        setStatus(refusal ?? result.message);
      }
    };

    const moveLastFirst = () => {
      const media = batch?.media ?? [];
      if (!draft || media.length < 2) return;
      draft.stage({
        kind: "moveMedia",
        inputId: referenceInputId,
        fromOrdinal: media.length - 1,
        toOrdinal: 0,
      });
    };

    return h(
      "div",
      { style: { display: "grid", gap: 8 } },
      h(
        "div",
        { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
        ...(batch?.media ?? []).map((item) =>
          h(
            "button",
            {
              key: item.itemId,
              type: "button",
              onClick: () => edit(`${template}${referenceMarker(item.itemId)}`),
            },
            `Insert ${labels.get(item.itemId)} (${item.displayName})`,
          ),
        ),
        h("button", { type: "button", onClick: moveLastFirst }, "Move last reference first"),
      ),
      h("textarea", {
        "aria-label": "Reference prompt template",
        value: template,
        rows: 2,
        onChange: (event: { target: { value: string } }) => edit(event.target.value),
      }),
      h(
        "div",
        { "aria-label": "Resolved prompt" },
        preview.ok
          ? preview.text
          : `${preview.missing.length} reference(s) no longer resolve.`,
      ),
      // What the draft addresses, so a test can see the held prompt is not
      // among them.
      h(
        "p",
        { "data-testid": "staged-inputs" },
        (state?.inputs ?? []).map((input) => input.id).join(","),
      ),
      h("button", { type: "button", disabled: !state?.canCommit, onClick: commit }, "Commit prompt"),
      h("p", { role: "status" }, state?.error ?? status),
    );
  }

  generation.ui.registerSection({
    id: "reference-prompt",
    apiVersion: 1,
    kind: "trusted-react",
    component: ReferencePromptSection,
  });
  context.logger.info("Reference prompt conformance fixture activated.");
};
