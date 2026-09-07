/**
 * Loader for the optional MiniMax Prompt Composer package, which lives in the
 * git-ignored runtime extension root with its own repository.
 *
 * Two problems to solve at once, and they pull in opposite directions.
 *
 * At *runtime* the suite wants the real package, so the imports below are
 * static and this module is only ever dynamically imported by
 * MinimaxSubjectsConformance.test.ts after it has checked the package exists.
 * On a checkout without it, this file is never loaded and the unresolved
 * imports never execute.
 *
 * At *typecheck* time `tsc -b` compiles this file regardless. `@ts-ignore`
 * silences the missing module, but that leaves the star-imports typed as
 * nothing — and every `const { activate } = await loadPackage()` in the suite
 * then fails with "property does not exist". So the surface the suite depends
 * on is declared here explicitly, and the imports are widened to it. A clean
 * clone typechecks; a checkout with the package still gets the real thing at
 * runtime.
 *
 * Declaring the contract rather than inferring it is also the idiom the
 * cross-package fixtures already use (`FalseColorPeerApi` in exposure-report,
 * `TaggingApi` in tagging): what one package relies on from another is worth
 * writing down.
 */
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as indexModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/index";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as subjectModelModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/subjectModel";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as subjectStoreModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/subjectStore";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as tagsModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/tags";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as suggestionsModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/suggestions";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as lineBindingsModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/lineBindings";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as listViewModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/SubjectsListView";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as editorViewModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/SubjectEditorView";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as presentationModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/subjectPresentation";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
import * as editorSessionModule from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/editorSession";
import type { ExtensionModule, JsonValue } from "../../types";

/** A reference in emission order. Mirrors the package's `DerivedTag`. */
export interface LoadedTag {
  readonly key: string;
  readonly kind: "Picture" | "Video" | "Audio";
  readonly ordinal: number;
  readonly text: string;
  readonly fromVideoKey?: string;
  readonly uncertain?: boolean;
}

export interface LoadedSubjectAsset {
  readonly assetId: string;
  readonly includeAudio?: boolean;
}

export interface LoadedSubject {
  readonly id: string;
  readonly label: string;
  readonly assets: readonly LoadedSubjectAsset[];
  readonly lines: readonly string[];
  readonly updatedAt: number;
}

type SubjectCommand = (subject: LoadedSubject) => LoadedSubject;

export interface LoadedSubjectStore {
  getState(): { readonly status: string; readonly subjects: readonly LoadedSubject[] };
  subscribe(listener: () => void): () => void;
  create(label: string): Promise<string | null>;
  update(id: string, mutate: SubjectCommand): Promise<void>;
  remove(id: string): Promise<void>;
  dispose(): void;
}

export interface LoadedEditorSession {
  getSubjectId(): string | null;
  setSubjectId(id: string | null): void;
  getDraft(subjectId: string): {
    readonly text: string;
    readonly tags: readonly LoadedTag[] | null;
    readonly editing: unknown;
  };
  updateDraft(subjectId: string, next: Record<string, unknown>): void;
  clearDraft(subjectId: string): void;
  subscribe(listener: () => void): () => void;
  getRevision(): number;
}

/**
 * Everything MinimaxSubjectsConformance.test.tsx reaches for. Adding a test
 * that needs a new export means adding it here too — which is the point: the
 * host suite's dependency on an out-of-tree package should be visible.
 */
export interface MinimaxPromptPackage {
  readonly activate: ExtensionModule["activate"];
  readonly SUBJECTS_VIEW_ID: string;
  readonly SUBJECT_EDITOR_VIEW_ID: string;
  readonly EDITING_CONTEXT_KEY: string;
  readonly SUBJECT_INDEX_KEY: string;
  readonly MISSING_REFERENCE_TEXT: string;

  createSubjectStore(api: unknown): LoadedSubjectStore;
  createEditorSession(): LoadedEditorSession;
  createSubjectsListView(deps: never): unknown;
  createSubjectEditorView(deps: never): unknown;

  parseSubject(id: string, value: JsonValue): LoadedSubject | null;
  serializeSubject(subject: LoadedSubject): JsonValue;
  parseSubjectIndex(
    value: JsonValue | undefined,
  ): { readonly schemaVersion: number; readonly subjectIds: readonly string[] } | null;

  attachAsset(assetId: string): SubjectCommand;
  attachAssetAt(assetId: string, index: number): SubjectCommand;
  renameSubject(label: string): SubjectCommand;
  appendLines(lines: readonly string[]): SubjectCommand;
  replaceLine(index: number, lines: readonly string[]): SubjectCommand;
  removeLine(index: number): SubjectCommand;
  shiftLine(index: number, delta: number): SubjectCommand;
  splitIntoLines(text: string): string[];

  deriveTags(items: readonly Record<string, unknown>[]): readonly LoadedTag[];
  subjectTagInputs(
    assets: readonly LoadedSubjectAsset[],
    resolve: (assetId: string) => unknown,
  ): readonly unknown[];

  bindLine(
    text: string,
    tags: readonly LoadedTag[],
    subjectOrdinal: number,
  ): string;
  renderLine(
    stored: string,
    tags: readonly LoadedTag[],
    subjectTag: string,
  ): string;
  renderLineForEditing(
    stored: string,
    tags: readonly LoadedTag[],
    subjectTag: string,
  ): string;
  lineHasMissingReferences(
    stored: string,
    tags: readonly LoadedTag[],
  ): boolean;

  resolveSuggestions(
    subjectTag: string,
    tags: readonly LoadedTag[],
  ): readonly {
    readonly suggestion: { readonly id: string };
    readonly available: boolean;
    readonly text: string;
    readonly hint: string;
  }[];
}

export const minimaxPromptPackage = {
  ...indexModule,
  ...subjectModelModule,
  ...subjectStoreModule,
  ...tagsModule,
  ...suggestionsModule,
  ...lineBindingsModule,
  ...listViewModule,
  ...editorViewModule,
  ...presentationModule,
  ...editorSessionModule,
} as unknown as MinimaxPromptPackage;
