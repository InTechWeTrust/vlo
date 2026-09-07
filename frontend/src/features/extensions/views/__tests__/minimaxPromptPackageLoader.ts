/**
 * Loader for the optional MiniMax Prompt Composer package, which lives in the
 * git-ignored runtime extension root. This module is only dynamically imported
 * by MinimaxSubjectsConformance.test.ts after it has verified the package
 * exists on disk; on checkouts without the package this file is never loaded,
 * so the unresolved static imports below never execute. The ts-ignore keeps
 * `tsc` green on such checkouts.
 */
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore - optional package, absent unless installed into extensions/installed/
export * from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/index";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
export * from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/subjectModel";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
export * from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/subjectStore";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
export * from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/tags";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
export * from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/suggestions";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
export * from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/SubjectsListView";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
export * from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/SubjectEditorView";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
export * from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/subjectPresentation";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
export * from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/editorSession";
// @ts-ignore - optional package, absent unless installed into extensions/installed/
export * from "../../../../../../extensions/installed/vlo.minimax-prompt/frontend/src/lineBindings";
