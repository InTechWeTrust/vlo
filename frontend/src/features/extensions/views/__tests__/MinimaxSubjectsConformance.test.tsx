import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionHost } from "../../ExtensionHost";
import { createVloExtensionApi } from "../../services/FrontendExtensionRuntime";
import type {
  ExtensionKeyValueStore,
  ExtensionModule,
  JsonValue,
  VloExtensionApi,
} from "../../types";
import { hostViewRegistry } from "../../../../core/shell/viewRegistry";
import { hostContextKeys } from "../../../../core/shell/contextKeys";
import type { MinimaxPromptPackage } from "./minimaxPromptPackageLoader";
import { createMuiStubs } from "./minimaxHostStubs";

const EXTENSION_ID = "vlo.minimax-prompt";

// The MiniMax Prompt Composer is an optional package installed into the
// git-ignored runtime extension root. When present it is the conformance
// fixture for the Subjects half of the plan (Phase 2); on checkouts without it
// this suite skips rather than failing. Same shape as the Bezier Curves
// suite: the static imports live in a loader module that is only dynamically
// imported after the existence check.
const PACKAGE_ENTRY_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../..",
  "extensions/installed",
  EXTENSION_ID,
  "frontend/src/index.ts",
);
const packagePresent = existsSync(PACKAGE_ENTRY_PATH);

async function loadPackage(): Promise<MinimaxPromptPackage> {
  return (await import("./minimaxPromptPackageLoader")).minimaxPromptPackage;
}

/**
 * A project storage scope backed by a plain map, standing in for the host's
 * debounced document. Reusing one `values` map across two stores is how this
 * suite models a project close and reopen: the bytes survive, the in-memory
 * store does not.
 */
function createScope(values: Map<string, JsonValue>): ExtensionKeyValueStore {
  const listeners = new Set<() => void>();
  let revision = 0;
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, structuredClone(value));
      revision += 1;
      for (const listener of [...listeners]) listener();
    },
    delete: async (key) => {
      values.delete(key);
      revision += 1;
      for (const listener of [...listeners]) listener();
    },
    keys: async () => [...values.keys()],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getRevision: () => revision,
  };
}

function createStoreApi(
  scope: ExtensionKeyValueStore | null,
  projectListeners?: Set<() => void>,
) {
  return {
    storage: { project: scope },
    project: {
      get: () => (scope ? { id: "p1" } : null),
      subscribe: (listener: () => void) => {
        projectListeners?.add(listener);
        return () => projectListeners?.delete(listener);
      },
    },
  };
}

/**
 * A scope that can hold one key's read open.
 *
 * Blocking *every* read would not reproduce the race: the load would then do
 * all its reading after the competing edit had already been written, and see
 * the new data. The bug needs a load that has read the stale documents and is
 * still on its way to publishing them, so only the last read — the index — is
 * held.
 */
function createBlockableScope(values: Map<string, JsonValue>): {
  scope: ExtensionKeyValueStore;
  blockKey(key: string): void;
  release(): void;
} {
  const inner = createScope(values);
  let blockedKey: string | null = null;
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  return {
    scope: {
      ...inner,
      get: async (key) => {
        if (gate && key === blockedKey) await gate;
        return inner.get(key);
      },
    },
    blockKey: (key) => {
      blockedKey = key;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release: () => {
      gate = null;
      blockedKey = null;
      open?.();
      open = null;
    },
  };
}

/** Resolves once the store has finished its initial asynchronous hydration. */
async function whenReady(store: {
  getState(): { status: string };
}): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (store.getState().status === "ready") return;
    await Promise.resolve();
  }
  throw new Error(`Store never became ready (status ${store.getState().status})`);
}

type AssetLookup = (assetId: string) => unknown;

const DEFAULT_ASSET_LOOKUP: AssetLookup = (assetId) => ({
  id: assetId,
  hash: "h",
  name: `${assetId}.png`,
  type: "image" as const,
  src: `blob:${assetId}`,
});

/**
 * Mounts the real subject *editor* view with the host singletons stubbed,
 * capturing the props it hands the batch drop slot. dnd-kit itself is
 * host-owned and covered elsewhere; what is this package's to get right is
 * what those callbacks do.
 */
function mountEditor(
  createSubjectEditorView: (deps: never) => unknown,
  store: unknown,
  session: { setSubjectId(id: string | null): void },
  subjectId: string,
  capture: (props: Record<string, unknown>) => void,
  assetLookup: AssetLookup = DEFAULT_ASSET_LOOKUP,
): ReturnType<typeof render> {
  const api = {
    assets: {
      get: assetLookup,
      subscribe: () => () => undefined,
      getRevision: () => 0,
    },
    runtime: {
      react: React,
      mui: createMuiStubs(),
      panelUi: {
        AssetBatchDropSlot: (props: Record<string, unknown>) => {
          capture(props);
          return null;
        },
      },
    },
  };
  session.setSubjectId(subjectId);
  // The SDK types a view component as returning `unknown`, because an
  // extension has no React types to name a node with; the host mount casts it
  // the same way.
  const View = createSubjectEditorView({
    api: api as unknown as VloExtensionApi,
    store,
    session,
    react: React as never,
  } as never) as unknown as React.FunctionComponent<{
    viewId: string;
    region: string;
    active: boolean;
  }>;
  return render(
    React.createElement(View, {
      viewId: "v",
      region: "right-sidebar",
      active: true,
    }),
  );
}

let activeHost: ExtensionHost<VloExtensionApi> | undefined;

afterEach(async () => {
  if (activeHost) {
    await activeHost.deactivate(EXTENSION_ID);
    activeHost = undefined;
  }
});

describe.skipIf(!packagePresent)("minimax subjects conformance fixture", () => {
  // 2A — package skeleton, and the two surfaces the drag problem forced.
  it("registers a sidebar tab and an editor panel, and removes both on deactivation", async () => {
    const { activate, SUBJECTS_VIEW_ID, SUBJECT_EDITOR_VIEW_ID } =
      await loadPackage();
    const listId = `${EXTENSION_ID}/${SUBJECTS_VIEW_ID}`;
    const editorId = `${EXTENSION_ID}/${SUBJECT_EDITOR_VIEW_ID}`;

    const host = new ExtensionHost<VloExtensionApi>({
      sdkVersion: "1.21.0",
      createApi: createVloExtensionApi,
    });
    activeHost = host;
    await host.activate(
      { id: EXTENSION_ID, version: "0.1.0" },
      { activate: activate as ExtensionModule["activate"] },
    );

    expect(hostViewRegistry.get(listId)?.defaultRegion).toBe("left-sidebar");
    expect(hostViewRegistry.get(listId)?.title).toBe("Subjects");
    expect(
      hostViewRegistry
        .list("left-sidebar", { includeHidden: true })
        .some((view) => view.id === listId),
    ).toBe(true);

    // The editor goes opposite the asset browser. A sidebar shows one tab at
    // a time, so a subject edited in the *left* sidebar could never sit beside
    // the assets its references are dragged from.
    expect(hostViewRegistry.get(editorId)?.defaultRegion).toBe("right-sidebar");
    // Portable, so the placement is finally the user's to change.
    expect(hostViewRegistry.get(editorId)?.allowedRegions).toEqual([
      "right-sidebar",
      "bottom-dock",
    ]);

    await host.deactivate(EXTENSION_ID);
    activeHost = undefined;
    expect(hostViewRegistry.get(listId)).toBeUndefined();
    expect(hostViewRegistry.get(editorId)).toBeUndefined();
  });

  it("does not put the editor in the region that holds the asset browser", async () => {
    const { activate, SUBJECT_EDITOR_VIEW_ID } = await loadPackage();
    const host = new ExtensionHost<VloExtensionApi>({
      sdkVersion: "1.21.0",
      createApi: createVloExtensionApi,
    });
    activeHost = host;
    await host.activate(
      { id: EXTENSION_ID, version: "0.1.0" },
      { activate: activate as ExtensionModule["activate"] },
    );
    // Regression guard for the reason this split exists: the drop target and
    // the asset browser must be able to be on screen at the same time.
    const editor = hostViewRegistry.get(
      `${EXTENSION_ID}/${SUBJECT_EDITOR_VIEW_ID}`,
    );
    expect(editor?.defaultRegion).not.toBe("left-sidebar");
  });

  it("keeps the editor out of the sidebar until a subject is being edited", async () => {
    const { activate, SUBJECT_EDITOR_VIEW_ID, EDITING_CONTEXT_KEY } =
      await loadPackage();
    const editorId = `${EXTENSION_ID}/${SUBJECT_EDITOR_VIEW_ID}`;
    const contextKey = `extension.${EXTENSION_ID}.${EDITING_CONTEXT_KEY}`;

    // The host refuses to let anything but the owning extension write an
    // `extension.` key, so the test drives the same api the package does
    // rather than forging the context key.
    let api: VloExtensionApi | undefined;
    const host = new ExtensionHost<VloExtensionApi>({
      sdkVersion: "1.22.0",
      createApi: (scope) => {
        api = createVloExtensionApi(scope);
        return api;
      },
    });
    activeHost = host;
    await host.activate(
      { id: EXTENSION_ID, version: "0.1.0" },
      { activate: activate as ExtensionModule["activate"] },
    );

    // Registering does not cost a tab. The right sidebar already reaches five
    // tabs with a clip selected, and this panel is only meaningful on demand.
    expect(hostContextKeys.get(contextKey)).toBe(false);
    expect(
      hostViewRegistry
        .list("right-sidebar", { includeHidden: true })
        .some((view) => view.id === editorId),
    ).toBe(false);
    expect(hostViewRegistry.select("right-sidebar", editorId)).toBe(false);

    // Opening a subject is what brings it in — this is the key the extension
    // publishes when the list view hands it a subject.
    act(() => void api?.ui.commands.setContextKey(EDITING_CONTEXT_KEY, true));
    expect(
      hostViewRegistry
        .list("right-sidebar", { includeHidden: true })
        .some((view) => view.id === editorId),
    ).toBe(true);
    expect(hostViewRegistry.select("right-sidebar", editorId)).toBe(true);
    // Never the region that holds the asset browser, whatever the key says.
    expect(hostViewRegistry.select("left-sidebar", editorId)).toBe(false);

    act(() => void api?.ui.commands.setContextKey(EDITING_CONTEXT_KEY, false));
    expect(
      hostViewRegistry
        .list("right-sidebar", { includeHidden: true })
        .some((view) => view.id === editorId),
    ).toBe(false);
  });

  it("keeps unsaved text per subject and across the panel unmounting", async () => {
    const { createEditorSession } = await loadPackage();
    const session = createEditorSession();

    session.setSubjectId("a");
    session.updateDraft("a", { text: "half a sentence about A" });
    // Switching subjects must not carry the text across — which is what
    // component state used to do, since it is per-mount, not per-subject.
    session.setSubjectId("b");
    expect(session.getDraft("b").text).toBe("");
    session.updateDraft("b", { text: "about B" });

    // Ending the session unmounts the panel; the text survives it.
    session.setSubjectId(null);
    expect(session.getDraft("a").text).toBe("half a sentence about A");
    session.setSubjectId("a");
    expect(session.getDraft("a").text).toBe("half a sentence about A");

    session.clearDraft("a");
    expect(session.getDraft("a").text).toBe("");
    expect(session.getDraft("b").text).toBe("about B");
  });

  /**
   * Checks the declared package boundary as far as a host-side suite can: the
   * manifest's shape and the presence of the bundle it points at.
   *
   * This is *not* the installation gate. Nothing here goes through discovery,
   * digest approval, or loading the built bundle — the test below activates
   * the TypeScript source directly. That path is Phase 4's to cover.
   */
  it("declares a manifest the host can read, pointing at a built bundle", async () => {
    const packageRoot = dirname(dirname(PACKAGE_ENTRY_PATH));
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, "../manifest.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.id).toBe(EXTENSION_ID);
    expect(manifest.capabilities).toContain("ui.custom");
    // The full-reference composer binds prose to media `itemId`s, resolves in
    // the draft commit reading and holds its prompt with `holdInputIds` — all
    // SDK 1.26.0.
    expect(manifest.sdk).toBe(">=1.26.0 <2.0.0");

    const entry = (manifest.frontend as { entry: string }).entry;
    expect(
      existsSync(resolve(packageRoot, "..", entry)),
      `Declared entry '${entry}' is missing. Run 'npm run build' in ${packageRoot}.`,
    ).toBe(true);
  });

  // 2B — subject model and storage.
  it("persists subjects across a project close and reopen", async () => {
    const { createSubjectStore, attachAsset, appendLines } = await loadPackage();
    const values = new Map<string, JsonValue>();

    const first = createSubjectStore(createStoreApi(createScope(values)));
    await whenReady(first);
    await first.create("Amelia");
    const created = first.getState().subjects[0];
    await first.update(created.id, attachAsset("asset-1"));
    await first.update(created.id, appendLines(["<Subject 1> is the woman in <Picture 1>."]));
    first.dispose();

    // A fresh store over the same bytes is exactly what a reopen produces.
    const reopened = createSubjectStore(createStoreApi(createScope(values)));
    await whenReady(reopened);
    const subjects = reopened.getState().subjects;
    expect(subjects).toHaveLength(1);
    expect(subjects[0].id).toBe(created.id);
    expect(subjects[0].label).toBe("Amelia");
    expect(subjects[0].assets).toEqual([{ assetId: "asset-1" }]);
    expect(subjects[0].lines).toEqual([
      "<Subject 1> is the woman in <Picture 1>.",
    ]);
    reopened.dispose();
  });

  it("reports no project rather than an empty list when storage is unavailable", async () => {
    const { createSubjectStore } = await loadPackage();
    const store = createSubjectStore(createStoreApi(null));
    await Promise.resolve();
    expect(store.getState().status).toBe("no-project");
    store.dispose();
  });

  it("recovers a subject document the index does not mention", async () => {
    const { createSubjectStore, serializeSubject, SUBJECT_INDEX_KEY } =
      await loadPackage();
    const values = new Map<string, JsonValue>();
    values.set(
      "subject:orphan",
      serializeSubject({
        id: "orphan",
        label: "Orphan",
        assets: [],
        lines: [],
        updatedAt: 1,
      }),
    );
    values.set(SUBJECT_INDEX_KEY, {
      schemaVersion: 1,
      subjectIds: [],
    } as JsonValue);

    const store = createSubjectStore(createStoreApi(createScope(values)));
    await whenReady(store);
    expect(store.getState().subjects.map((subject) => subject.label)).toEqual([
      "Orphan",
    ]);
    store.dispose();
  });

  it("refuses a document written by a newer schema version", async () => {
    const { parseSubject } = await loadPackage();
    expect(
      parseSubject("s1", {
        schemaVersion: 99,
        label: "From the future",
        assets: [],
        lines: [],
        updatedAt: 1,
      } as JsonValue),
    ).toBeNull();
  });

  // 2C — asset attachment, driven through the props the view hands the host's
  // own drop slot. dnd-kit itself is host-owned and covered elsewhere; what is
  // this package's to get right is what the callbacks do.
  it("lands a dropped asset in the subject and persists it", async () => {
    const { createSubjectStore, createSubjectEditorView, createEditorSession } =
      await loadPackage();
    const values = new Map<string, JsonValue>();
    const store = createSubjectStore(createStoreApi(createScope(values)));
    await whenReady(store);
    await store.create("Amelia");
    const subject = store.getState().subjects[0];

    let dropSlotProps: Record<string, unknown> | undefined;
    const view = mountEditor(
      createSubjectEditorView,
      store,
      createEditorSession(),
      subject.id,
      (props) => {
        dropSlotProps = props;
      },
      (assetId) =>
        assetId === "asset-1"
          ? {
              id: "asset-1",
              hash: "h",
              name: "amelia.png",
              type: "image" as const,
              src: "blob:amelia",
            }
          : undefined,
    );

    expect(dropSlotProps).toBeDefined();
    expect(dropSlotProps?.accept).toEqual(["image", "video", "audio"]);

    await act(async () => {
      (dropSlotProps?.onDrop as (index: number, asset: { id: string }) => void)(
        0,
        { id: "asset-1" },
      );
    });

    expect(store.getState().subjects[0].assets).toEqual([{ assetId: "asset-1" }]);
    // The same drop twice must not take two ordinals for one asset.
    await act(async () => {
      (dropSlotProps?.onDrop as (index: number, asset: { id: string }) => void)(
        0,
        { id: "asset-1" },
      );
    });
    expect(store.getState().subjects[0].assets).toHaveLength(1);

    // And it reached storage, not just the in-memory list.
    expect(values.get(`subject:${subject.id}`)).toMatchObject({
      assets: [{ assetId: "asset-1" }],
    });
    view.unmount();
    store.dispose();
  });

  it("opens the floating editor on the subject New subject creates", async () => {
    const { createSubjectStore, createSubjectsListView, createEditorSession } =
      await loadPackage();
    const values = new Map<string, JsonValue>();
    const store = createSubjectStore(createStoreApi(createScope(values)));
    await whenReady(store);
    const session = createEditorSession();
    let opened = 0;

    const api = {
      assets: {
        get: DEFAULT_ASSET_LOOKUP,
        subscribe: () => () => undefined,
        getRevision: () => 0,
      },
      runtime: {
        react: React,
        mui: createMuiStubs(),
        panelUi: {},
      },
    };
    const View = (
      createSubjectsListView as (deps: never) => unknown
    )({
      api: api as unknown as VloExtensionApi,
      store,
      session,
      react: React as never,
      openEditor: () => {
        opened += 1;
      },
    } as never) as unknown as React.FunctionComponent<{
      viewId: string;
      region: string;
      active: boolean;
    }>;
    const view = render(
      React.createElement(View, {
        viewId: "v",
        region: "left-sidebar",
        active: true,
      }),
    );

    const newSubject = view.getByText("New subject");
    await act(async () => {
      fireEvent.click(newSubject);
    });

    // Creating has to land the user in the overlay: the first thing a subject
    // needs is assets, and they can only be dragged from the browser this tab
    // would otherwise be covering.
    expect(store.getState().subjects).toHaveLength(1);
    expect(session.getSubjectId()).toBe(store.getState().subjects[0].id);
    expect(opened).toBe(1);
    view.unmount();
    store.dispose();
  });

  it("keeps an asset that has left the library, marked broken", async () => {
    const { subjectTagInputs } = await loadPackage();
    // The tag inputs skip it — a missing asset takes no ordinal — while the
    // subject itself still holds it, which is what the view renders as broken.
    expect(subjectTagInputs([{ assetId: "gone" }], () => undefined)).toEqual([]);
  });

  // 2D — description composer.
  it("commits one line per suggestion and reorders and deletes lines", async () => {
    const {
      createSubjectStore,
      resolveSuggestions,
      appendLines,
      shiftLine,
      removeLine,
      splitIntoLines,
      deriveTags,
    } = await loadPackage();
    const values = new Map<string, JsonValue>();
    const store = createSubjectStore(createStoreApi(createScope(values)));
    await whenReady(store);
    await store.create("Amelia");
    const id = store.getState().subjects[0].id;

    const tags = deriveTags([{ key: "asset-1", mediaType: "image" }]);
    const suggestions = resolveSuggestions("<Subject 1>", tags);
    const identity = suggestions.find((item) => item.suggestion.id === "identity");
    expect(identity?.available).toBe(true);
    expect(identity?.text).toBe("<Subject 1> is the person shown in <Picture 1>.");

    // A suggestion with no asset of its kind is offered as unavailable with a
    // reason, never as a sentence citing a tag that will not be emitted.
    const voice = suggestions.find((item) => item.suggestion.id === "voice");
    expect(voice?.available).toBe(false);
    expect(voice?.text).toBe("");
    expect(voice?.hint).toContain("audio");

    const edited = `${identity?.text} She has long dark hair.`;
    await store.update(id, appendLines(splitIntoLines(edited)));
    expect(store.getState().subjects[0].lines).toEqual([edited]);

    await store.update(id, appendLines(splitIntoLines("Second line.")));
    await store.update(id, shiftLine(1, -1));
    expect(store.getState().subjects[0].lines[0]).toBe("Second line.");

    await store.update(id, removeLine(0));
    expect(store.getState().subjects[0].lines).toEqual([edited]);
    store.dispose();
  });

  it("commits a multi-line paste as separate lines", async () => {
    const { splitIntoLines } = await loadPackage();
    expect(splitIntoLines("  one \n\n two  \n")).toEqual(["one", "two"]);
  });

  // The emission rule the whole composer rests on, taken from the worked
  // example in docs/deep_dive/minimax-h3-reference-tags.md §3.1.
  it("derives the documented tag assignment for the worked example", async () => {
    const { deriveTags } = await loadPackage();
    const tags = deriveTags([
      { key: "A", mediaType: "image" },
      { key: "B", mediaType: "image" },
      { key: "V1", mediaType: "video", audioEnabled: false, hasAudio: false },
      { key: "V2", mediaType: "video", audioEnabled: true, hasAudio: true },
      { key: "V3", mediaType: "video", audioEnabled: true, hasAudio: true },
      { key: "S1", mediaType: "audio" },
      { key: "S2", mediaType: "audio" },
    ]);

    expect(tags.map((tag) => [tag.text, tag.key])).toEqual([
      ["<Picture 1>", "A"],
      ["<Picture 2>", "B"],
      ["<Video 1>", "V1"],
      ["<Audio 1>", "V2"],
      ["<Video 2>", "V2"],
      ["<Audio 2>", "V3"],
      ["<Video 3>", "V3"],
      ["<Audio 3>", "S1"],
      ["<Audio 4>", "S2"],
    ]);
  });

  it("emits no audio tag for a silent video with its switch on", async () => {
    const { deriveTags } = await loadPackage();
    // The off-by-one trap: the switch is on but there is no soundtrack, so the
    // standalone audio takes <Audio 1> rather than <Audio 2>.
    const tags = deriveTags([
      { key: "V1", mediaType: "video", audioEnabled: true, hasAudio: false },
      { key: "S1", mediaType: "audio" },
    ]);
    expect(tags.map((tag) => tag.text)).toEqual(["<Video 1>", "<Audio 1>"]);
  });

  // Review finding 1 — prose must bind to assets, not to the ordinal an asset
  // happened to have when the sentence was written.
  it("keeps an authored sentence pointing at its asset across a reorder", async () => {
    const { bindLine, renderLine, deriveTags } = await loadPackage();
    const before = deriveTags([
      { key: "asset-a", mediaType: "image" },
      { key: "asset-b", mediaType: "image" },
    ]);
    const stored = bindLine(
      "<Subject 1> is the person shown in <Picture 1>.",
      before,
      1,
    );
    expect(stored).toBe(
      "{{subject}} is the person shown in {{ref:Picture:asset-a}}.",
    );

    // The user reorders the images; asset-a is now the second picture.
    const after = deriveTags([
      { key: "asset-b", mediaType: "image" },
      { key: "asset-a", mediaType: "image" },
    ]);
    expect(renderLine(stored, after, "<Subject 1>")).toBe(
      "<Subject 1> is the person shown in <Picture 2>.",
    );
  });

  it("binds a video's soundtrack separately from the video itself", async () => {
    const { bindLine, renderLine, deriveTags } = await loadPackage();
    const tags = deriveTags([
      { key: "vid", mediaType: "video", audioEnabled: true, hasAudio: true },
    ]);
    // Same key, two tags: the sentence about the voice must not resolve to
    // the picture, which is why the marker carries the kind.
    const stored = bindLine("<Audio 1> is the voice of <Video 1>.", tags, 1);
    expect(stored).toBe("{{ref:Audio:vid}} is the voice of {{ref:Video:vid}}.");
    expect(renderLine(stored, tags, "<Subject 1>")).toBe(
      "<Audio 1> is the voice of <Video 1>.",
    );
  });

  it("flags a line whose asset has left the subject instead of renumbering it", async () => {
    const { bindLine, renderLine, lineHasMissingReferences, deriveTags } =
      await loadPackage();
    const tags = deriveTags([{ key: "asset-a", mediaType: "image" }]);
    const stored = bindLine("Shown in <Picture 1>.", tags, 1);
    const emptied = deriveTags([]);
    expect(lineHasMissingReferences(stored, emptied)).toBe(true);
    expect(renderLine(stored, emptied, "<Subject 1>")).toContain("missing");
  });

  it("leaves an unbindable tag literal rather than inventing a binding", async () => {
    const { bindLine, deriveTags } = await loadPackage();
    const tags = deriveTags([{ key: "asset-a", mediaType: "image" }]);
    // <Picture 9> does not exist, and <Subject 2> is a different subject that
    // has no stable identity until the composer numbers them globally.
    const stored = bindLine("<Subject 2> and <Picture 9>.", tags, 1);
    expect(stored).toBe("<Subject 2> and <Picture 9>.");
  });

  it("commits a suggestion through the binding path, not as literal ordinals", async () => {
    const {
      createSubjectStore,
      resolveSuggestions,
      appendLines,
      splitIntoLines,
      bindLine,
      deriveTags,
    } = await loadPackage();
    const values = new Map<string, JsonValue>();
    const store = createSubjectStore(createStoreApi(createScope(values)));
    await whenReady(store);
    await store.create("Amelia");
    const id = store.getState().subjects[0].id;

    const tags = deriveTags([{ key: "asset-a", mediaType: "image" }]);
    const identity = resolveSuggestions("<Subject 1>", tags).find(
      (item) => item.suggestion.id === "identity",
    );
    const lines = splitIntoLines(identity?.text ?? "").map((line) =>
      bindLine(line, tags, 1),
    );
    await store.update(id, appendLines(lines));

    expect(store.getState().subjects[0].lines[0]).not.toContain("<Picture 1>");
    expect(store.getState().subjects[0].lines[0]).toContain(
      "{{ref:Picture:asset-a}}",
    );
    store.dispose();
  });

  // Editing a committed sentence.
  it("round-trips a committed line through edit unchanged", async () => {
    const { bindLine, renderLineForEditing, deriveTags } = await loadPackage();
    const tags = deriveTags([
      { key: "asset-a", mediaType: "image" },
      { key: "asset-b", mediaType: "image" },
    ]);
    const stored = bindLine(
      "<Subject 1> is the person shown in <Picture 2>.",
      tags,
      1,
    );
    // Opening the editor shows resolved ordinals; saving without touching
    // anything must produce byte-identical storage.
    const editable = renderLineForEditing(stored, tags, "<Subject 1>");
    expect(editable).toBe("<Subject 1> is the person shown in <Picture 2>.");
    expect(bindLine(editable, tags, 1)).toBe(stored);
  });

  it("keeps a dangling reference intact through an edit", async () => {
    const {
      bindLine,
      renderLine,
      renderLineForEditing,
      deriveTags,
      MISSING_REFERENCE_TEXT,
    } = await loadPackage();
    const authored = deriveTags([{ key: "asset-a", mediaType: "image" }]);
    const stored = bindLine("Shown in <Picture 1>.", authored, 1);

    // The asset leaves the subject. The *display* says so...
    const emptied = deriveTags([]);
    expect(renderLine(stored, emptied, "<Subject 1>")).toContain(
      MISSING_REFERENCE_TEXT,
    );

    // ...but the edit box must show the raw marker, not that friendly text,
    // or saving would store the words "missing reference" and destroy the
    // knowledge of which asset the sentence was about.
    const editable = renderLineForEditing(stored, emptied, "<Subject 1>");
    expect(editable).not.toContain(MISSING_REFERENCE_TEXT);
    expect(editable).toContain("{{ref:Picture:asset-a}}");

    // Editing the prose around it and saving keeps the binding, so restoring
    // the asset restores the sentence.
    const edited = bindLine(`Clearly ${editable}`, emptied, 1);
    expect(renderLine(edited, authored, "<Subject 1>")).toBe(
      "Clearly Shown in <Picture 1>.",
    );
  });

  it("replaces one line with the lines an edit produced", async () => {
    const { replaceLine } = await loadPackage();
    const subject = {
      id: "s",
      label: "S",
      assets: [],
      lines: ["one", "two", "three"],
      updatedAt: 0,
    };
    expect(replaceLine(1, ["two a", "two b"])(subject).lines).toEqual([
      "one",
      "two a",
      "two b",
      "three",
    ]);
    // An edit that empties the box removes the line.
    expect(replaceLine(1, [])(subject).lines).toEqual(["one", "three"]);
    expect(replaceLine(9, ["x"])(subject)).toBe(subject);
  });

  it("binds an edit against the tags the author saw, not a later reorder", async () => {
    const { bindLine, renderLineForEditing, renderLine, deriveTags } =
      await loadPackage();
    const atEditStart = deriveTags([
      { key: "asset-a", mediaType: "image" },
      { key: "asset-b", mediaType: "image" },
    ]);
    const stored = bindLine("Shown in <Picture 1>.", atEditStart, 1);
    const editable = renderLineForEditing(stored, atEditStart, "<Subject 1>");

    // While the box is open the user drags the images around, so `<Picture 1>`
    // now names asset-b. The text on screen still says what it said, so the
    // save must bind against the snapshot taken when editing began.
    const afterReorder = deriveTags([
      { key: "asset-b", mediaType: "image" },
      { key: "asset-a", mediaType: "image" },
    ]);
    const saved = bindLine(editable, atEditStart, 1);
    expect(saved).toBe("Shown in {{ref:Picture:asset-a}}.");
    expect(renderLine(saved, afterReorder, "<Subject 1>")).toBe(
      "Shown in <Picture 2>.",
    );

    // Binding against the current tags instead would have silently retargeted
    // the sentence onto asset-b.
    expect(bindLine(editable, afterReorder, 1)).toBe(
      "Shown in {{ref:Picture:asset-b}}.",
    );
  });

  it("edits a committed line through the view", async () => {
    const {
      createSubjectStore,
      createSubjectEditorView,
      createEditorSession,
      attachAssetAt,
      appendLines,
      bindLine,
      deriveTags,
    } = await loadPackage();
    const values = new Map<string, JsonValue>();
    const store = createSubjectStore(createStoreApi(createScope(values)));
    await whenReady(store);
    await store.create("Amelia");
    const id = store.getState().subjects[0].id;
    await store.update(id, attachAssetAt("asset-1", 0));
    const tags = deriveTags([{ key: "asset-1", mediaType: "image" }]);
    await store.update(
      id,
      appendLines([bindLine("Shown in <Picture 1>.", tags, 1)]),
    );

    const view = mountEditor(
      createSubjectEditorView,
      store,
      createEditorSession(),
      id,
      () => undefined,
    );

    // The stored line is displayed with its ordinal resolved.
    expect(view.getByText("Shown in <Picture 1>.")).toBeTruthy();

    // The pencil button itself, not the tooltip wrapping it: a click on the
    // parent does not reach a child's handler.
    await act(async () => {
      fireEvent.click(view.getByText("\u270e"));
    });
    // Several text boxes are on screen (the subject label, the draft box);
    // the edit box is the one seeded with the line's resolved text.
    const boxes = [
      ...view.container.querySelectorAll("textarea"),
    ] as HTMLTextAreaElement[];
    const box = boxes.find((candidate) => candidate.value === "Shown in <Picture 1>.");
    expect(box).toBeDefined();

    await act(async () => {
      fireEvent.change(box!, {
        target: { value: "Clearly shown in <Picture 1>." },
      });
    });
    await act(async () => {
      fireEvent.click(view.getByText("Save"));
    });

    // Stored bound, displayed resolved.
    expect(store.getState().subjects[0].lines).toEqual([
      "Clearly shown in {{ref:Picture:asset-1}}.",
    ]);
    expect(view.getByText("Clearly shown in <Picture 1>.")).toBeTruthy();
    view.unmount();
    store.dispose();
  });

  it("keeps an edit bound to its own asset when the strip is reordered mid-edit", async () => {
    const {
      createSubjectStore,
      createSubjectEditorView,
      createEditorSession,
      attachAssetAt,
      appendLines,
      bindLine,
      deriveTags,
    } = await loadPackage();
    const values = new Map<string, JsonValue>();
    const store = createSubjectStore(createStoreApi(createScope(values)));
    await whenReady(store);
    await store.create("Amelia");
    const id = store.getState().subjects[0].id;
    await store.update(id, attachAssetAt("asset-1", 0));
    await store.update(id, attachAssetAt("asset-2", 1));
    const tags = deriveTags([
      { key: "asset-1", mediaType: "image" },
      { key: "asset-2", mediaType: "image" },
    ]);
    await store.update(
      id,
      appendLines([bindLine("Shown in <Picture 1>.", tags, 1)]),
    );

    let dropSlotProps: Record<string, unknown> | undefined;
    const view = mountEditor(
      createSubjectEditorView,
      store,
      createEditorSession(),
      id,
      (props) => {
        dropSlotProps = props;
      },
    );

    await act(async () => {
      fireEvent.click(view.getByText("\u270e"));
    });

    // The user drags asset-1 to the end while the edit box is open, so
    // `<Picture 1>` now names asset-2 — but the text on screen still says what
    // it said when they opened it.
    await act(async () => {
      (dropSlotProps?.onReorder as (slotId: string, to: number) => void)(
        "asset-1",
        1,
      );
    });

    await act(async () => {
      fireEvent.click(view.getByText("Save"));
    });

    // Saving must bind to the asset the author was looking at, not to
    // whatever ordinal 1 became while they typed.
    expect(store.getState().subjects[0].lines).toEqual([
      "Shown in {{ref:Picture:asset-1}}.",
    ]);
    view.unmount();
    store.dispose();
  });

  // Review finding 2 — the batch slot's index names the tile that was dropped
  // on, which the native generation panel treats as "assign to this slot".
  it("replaces the targeted position when dropping on an occupied tile", async () => {
    const { attachAssetAt } = await loadPackage();
    const subject = {
      id: "s",
      label: "S",
      assets: [{ assetId: "a" }, { assetId: "b" }],
      lines: [],
      updatedAt: 0,
    };
    expect(attachAssetAt("c", 0)(subject).assets).toEqual([
      { assetId: "c" },
      { assetId: "b" },
    ]);
    // The add tile reports the current length and still appends.
    expect(attachAssetAt("c", 2)(subject).assets).toEqual([
      { assetId: "a" },
      { assetId: "b" },
      { assetId: "c" },
    ]);
    // An asset the subject already holds moves rather than duplicating: two
    // ordinals for one thing is not addressable by any sentence.
    expect(attachAssetAt("b", 0)(subject).assets).toEqual([
      { assetId: "b" },
      { assetId: "a" },
    ]);
    expect(attachAssetAt("a", 0)(subject)).toBe(subject);
  });

  it("drops a different asset onto an occupied tile through the view", async () => {
    const {
      createSubjectStore,
      createSubjectEditorView,
      createEditorSession,
      attachAssetAt,
    } = await loadPackage();
    const values = new Map<string, JsonValue>();
    const store = createSubjectStore(createStoreApi(createScope(values)));
    await whenReady(store);
    await store.create("Amelia");
    const id = store.getState().subjects[0].id;
    await store.update(id, attachAssetAt("asset-1", 0));

    let dropSlotProps: Record<string, unknown> | undefined;
    const view = mountEditor(
      createSubjectEditorView,
      store,
      createEditorSession(),
      id,
      (props) => {
        dropSlotProps = props;
      },
    );

    await act(async () => {
      (dropSlotProps?.onDrop as (index: number, asset: { id: string }) => void)(
        0,
        { id: "asset-2" },
      );
    });
    expect(store.getState().subjects[0].assets).toEqual([
      { assetId: "asset-2" },
    ]);
    view.unmount();
    store.dispose();
  });

  // Review finding 3 — a load in flight must not land on top of a newer edit.
  it("does not let an in-flight load revert a newer edit", async () => {
    const { createSubjectStore, renameSubject, SUBJECT_INDEX_KEY } =
      await loadPackage();
    const values = new Map<string, JsonValue>();
    const blockable = createBlockableScope(values);
    const projectListeners = new Set<() => void>();
    const store = createSubjectStore(
      createStoreApi(blockable.scope, projectListeners),
    );
    await whenReady(store);
    await store.create("Original");
    const id = store.getState().subjects[0].id;

    // A save notification starts a load. It reads the subject documents as
    // they are now ("Original") and then stalls before publishing them.
    blockable.blockKey(SUBJECT_INDEX_KEY);
    for (const listener of projectListeners) listener();
    for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();

    // The user edits while that load is still in flight.
    await store.update(id, renameSubject("Edited"));
    expect(store.getState().subjects[0].label).toBe("Edited");

    // The stalled load now finishes holding its older snapshot. It must not
    // publish it over the newer edit.
    blockable.release();
    for (let attempt = 0; attempt < 50; attempt += 1) await Promise.resolve();

    expect(store.getState().subjects[0].label).toBe("Edited");
    store.dispose();
  });

  // Review finding 4 — a newer index must not be rewritten as version 1.
  it("refuses to read or overwrite an index from a newer schema version", async () => {
    const { createSubjectStore, parseSubjectIndex, SUBJECT_INDEX_KEY } =
      await loadPackage();
    expect(
      parseSubjectIndex({ schemaVersion: 99, subjectIds: ["a"] } as JsonValue),
    ).toBeNull();

    const values = new Map<string, JsonValue>();
    const futureIndex = {
      schemaVersion: 99,
      subjectIds: ["a"],
      somethingNewer: true,
    } as JsonValue;
    values.set(SUBJECT_INDEX_KEY, futureIndex);

    const store = createSubjectStore(createStoreApi(createScope(values)));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (store.getState().status === "incompatible") break;
      await Promise.resolve();
    }
    expect(store.getState().status).toBe("incompatible");

    // Every write is refused, so the newer document survives intact.
    await store.create("New subject");
    expect(values.get(SUBJECT_INDEX_KEY)).toEqual(futureIndex);
    expect(store.getState().subjects).toEqual([]);
    store.dispose();
  });

  it("marks an undecidable soundtrack as uncertain rather than dropping it", async () => {
    const { deriveTags } = await loadPackage();
    const tags = deriveTags([
      { key: "sel", mediaType: "video", audioEnabled: true, hasAudio: null },
    ]);
    expect(tags.map((tag) => [tag.text, tag.uncertain === true])).toEqual([
      ["<Audio 1>", true],
      ["<Video 1>", false],
    ]);
  });
});
