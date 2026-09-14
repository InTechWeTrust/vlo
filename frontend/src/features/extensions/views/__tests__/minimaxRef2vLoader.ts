/**
 * Loader for the full-reference (ref2v) half of the optional MiniMax package
 * (docs/minimax-ref2v-prompt-composer-plan.md R1). Same contract as
 * `minimaxPromptPackageLoader.ts`: only imported after an on-disk presence
 * check, and the surface the suite relies on is declared rather than inferred
 * so a clean clone still typechecks.
 *
 * The inline reference editor is the package's own (plan §4.1), so so are the
 * DOM helpers a test drives it with: nothing here imports a host editor.
 */
/* eslint-disable @typescript-eslint/ban-ts-comment */
import { act } from "@testing-library/react";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as catalogueModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/referenceCatalogue";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as documentModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/referenceDocument";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as referenceComposerModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/ReferenceComposer";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as objectViewModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/PromptObjectView";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as composerViewModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/ComposerView";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as composerSessionModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/composerSession";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as inlineDocumentModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/inlineDocument";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as inlineDocumentDomModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/inlineDocumentDom";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as inlineHistoryModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/inlineDocumentHistory";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as runtimeBindingsModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/runtimeBindings";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as textInputModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/ReferenceTextInput";
import type { ExtensionGenerationInputSnapshot } from "../../types";

export interface LoadedInlineNode {
  readonly kind: "text" | "reference";
  readonly text?: string;
  readonly targetId?: string;
}

export type LoadedInlineNodeInput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reference"; readonly targetId: string };

export interface LoadedInlineDocument {
  readonly version: 1;
  readonly nodes: readonly LoadedInlineNodeInput[];
}

export interface LoadedInlineRange {
  readonly start: number;
  readonly end: number;
}

export interface LoadedCatalogueObject {
  readonly id: string;
  readonly kind: "Picture" | "Video" | "Audio";
  readonly channel: "visual" | "audio";
  readonly itemId: string;
  readonly ordinal: number;
  readonly label: string;
  readonly displayName: string;
  readonly state: "resolved" | "pending" | "uncertain";
}

export interface LoadedCatalogue {
  readonly objects: readonly LoadedCatalogueObject[];
  readonly byId: ReadonlyMap<string, LoadedCatalogueObject>;
  readonly byLabel: ReadonlyMap<string, LoadedCatalogueObject>;
  readonly silentSoundtracks: readonly { readonly itemId: string }[];
}

export interface LoadedReferenceDocument {
  readonly version: 1;
  readonly preamble: string;
  readonly subjects: readonly { readonly id: string; readonly name: string }[];
  readonly sections: Readonly<Record<string, LoadedInlineDocument>>;
  readonly styleOpening: LoadedInlineDocument;
  readonly shots: readonly { readonly id: string; readonly body: LoadedInlineDocument }[];
}

export type LoadedResolution =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly missing: readonly string[];
      readonly uncertain: readonly string[];
      readonly ambiguousShots: readonly number[];
    };

export interface LoadedInlineHistoryEntry {
  readonly document: LoadedInlineDocument;
  readonly selection: LoadedInlineRange;
}

export interface MinimaxRef2vPackage {
  buildReferenceCatalogue(
    inputs: readonly ExtensionGenerationInputSnapshot[],
    referenceInputIds: readonly string[],
  ): LoadedCatalogue;
  referenceTargeting(workflow: {
    readonly nodes: readonly { readonly classType: string; readonly mode: number }[];
  }): "single" | "none" | "ambiguous";
  inputObjectId(channel: "visual" | "audio", itemId: string): string;
  importReferencePrompt(
    text: string,
    catalogue: LoadedCatalogue,
  ):
    | {
        readonly ok: true;
        readonly document: LoadedReferenceDocument;
        readonly unbound: readonly string[];
      }
    | { readonly ok: false; readonly failure: { readonly kind: string; readonly reason: string } };
  resolveReferenceDocument(
    document: LoadedReferenceDocument,
    catalogue: LoadedCatalogue,
  ): LoadedResolution;
  bindReferenceText(
    text: string,
    resolve: (token: string) => string | null,
  ): LoadedInlineDocument;
  createReferenceLabeller(
    document: Pick<LoadedReferenceDocument, "subjects" | "shots">,
    catalogue: LoadedCatalogue,
  ): {
    label(targetId: string): string | null;
    target(token: string): string | null;
  };
  inlineDocument(nodes: readonly LoadedInlineNodeInput[]): LoadedInlineDocument;
  textDocument(text: string): LoadedInlineDocument;
  subjectTarget(subjectId: string): string;
  shotTarget(shotId: string): string;
  setProseSection(
    document: LoadedReferenceDocument,
    sectionId: string,
    value: LoadedInlineDocument,
  ): LoadedReferenceDocument;
  setShotBody(
    document: LoadedReferenceDocument,
    shotId: string,
    value: LoadedInlineDocument,
  ): LoadedReferenceDocument;
  addShot(document: LoadedReferenceDocument, id: string): LoadedReferenceDocument;
  removeShot(document: LoadedReferenceDocument, shotId: string): LoadedReferenceDocument;
  moveShot(
    document: LoadedReferenceDocument,
    shotId: string,
    offset: -1 | 1,
  ): LoadedReferenceDocument;
  addSubject(
    document: LoadedReferenceDocument,
    subject: { readonly id: string; readonly name: string },
  ): LoadedReferenceDocument;
  removeSubject(document: LoadedReferenceDocument, subjectId: string): LoadedReferenceDocument;
  moveSubject(
    document: LoadedReferenceDocument,
    subjectId: string,
    offset: -1 | 1,
  ): LoadedReferenceDocument;
  collectUnbound(document: LoadedReferenceDocument): readonly string[];
  splitDetailedDescription(
    text: string,
  ):
    | { readonly ok: true; readonly style: string; readonly shots: readonly string[] }
    | { readonly ok: false; readonly reason: string };
  MAX_IMPORTED_SUBJECTS: number;
  orderedReferenceInputs(
    inputs: readonly ExtensionGenerationInputSnapshot[],
    referenceInputIds: readonly string[],
  ): readonly ExtensionGenerationInputSnapshot[];
  createComposerView(deps: never): unknown;
  createComposerSession(): {
    getReferenceDraft(key: string): LoadedReferenceDocument | null;
    dispose(): void;
  };
  composerDraftKey(
    workflowFingerprint: string,
    inputId: string,
    projectId?: string | null,
  ): string;
  // The editor's own model, history and DOM mapping.
  createInlineDocument(nodes: readonly LoadedInlineNodeInput[]): LoadedInlineDocument;
  inlineDocumentLength(document: LoadedInlineDocument): number;
  replaceInlineRange(
    document: LoadedInlineDocument,
    range: LoadedInlineRange,
    insertion: readonly LoadedInlineNodeInput[],
  ): { readonly document: LoadedInlineDocument; readonly caret: number };
  sliceInlineDocument(
    document: LoadedInlineDocument,
    start: number,
    end: number,
  ): readonly LoadedInlineNodeInput[];
  previousInlineBoundary(
    document: LoadedInlineDocument,
    offset: number,
    unit: "character" | "word" | "line",
  ): number;
  nextInlineBoundary(
    document: LoadedInlineDocument,
    offset: number,
    unit: "character" | "word" | "line",
  ): number;
  parseInlineDocument(value: unknown): LoadedInlineDocument | null;
  readInlineDocumentFromDom(root: HTMLElement): LoadedInlineDocument;
  writeInlineSelection(root: HTMLElement, range: LoadedInlineRange): void;
  readInlineSelection(root: HTMLElement): LoadedInlineRange | null;
  InlineDocumentHistory: new () => {
    record(
      before: LoadedInlineHistoryEntry,
      after: LoadedInlineHistoryEntry,
      options?: { readonly coalesceKey?: string; readonly now?: number },
    ): void;
    undo(current: LoadedInlineHistoryEntry): LoadedInlineHistoryEntry | null;
    redo(current: LoadedInlineHistoryEntry): LoadedInlineHistoryEntry | null;
  };
  INLINE_DOCUMENT_CLIPBOARD_TYPE: string;
  createReferenceTextInput(ui: never): unknown;
  createHostBindings(api: never, react: never): unknown;
}

export const minimaxRef2vPackage = {
  ...catalogueModule,
  ...documentModule,
  ...referenceComposerModule,
  ...objectViewModule,
  ...composerViewModule,
  ...composerSessionModule,
  ...inlineDocumentModule,
  ...inlineDocumentDomModule,
  ...inlineHistoryModule,
  ...textInputModule,
  ...runtimeBindingsModule,
} as unknown as MinimaxRef2vPackage;

/**
 * Replace everything in the package's reference editor with `text`, the way a
 * user selecting all and typing would.
 *
 * The editor is a `contenteditable` that applies edits from `beforeinput`
 * itself, so `fireEvent.change` — which sets a form control's `value` — does
 * nothing to it. This drives the same event path a browser does.
 */
export function replaceReferenceText(element: HTMLElement, text: string): void {
  const pkg = minimaxRef2vPackage;
  act(() => {
    element.focus();
    const current = pkg.readInlineDocumentFromDom(element);
    pkg.writeInlineSelection(element, {
      start: 0,
      end: pkg.inlineDocumentLength(current),
    });
  });
  dispatchInput(
    element,
    text.length > 0
      ? { inputType: "insertText", data: text }
      : { inputType: "deleteContentBackward" },
  );
}

/** Put the caret at `offset` (clamped) and type `text` there. */
export function typeReferenceText(
  element: HTMLElement,
  text: string,
  offset = Number.MAX_SAFE_INTEGER,
): void {
  act(() => {
    element.focus();
    minimaxRef2vPackage.writeInlineSelection(element, { start: offset, end: offset });
  });
  dispatchInput(element, { inputType: "insertText", data: text });
}

export function dispatchInput(
  element: HTMLElement,
  init: { readonly inputType: string; readonly data?: string },
): InputEvent {
  const event = new InputEvent("beforeinput", {
    ...init,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

/**
 * What the editor shows, chips as their labels — read the way a user reads the
 * field, not as the document it edits.
 */
export function readReferenceText(element: HTMLElement): string {
  return (element.textContent ?? "").replace(/\uFEFF/g, "");
}
