import {
  createGenerationInputsDraft,
  type GenerationDraftCommitReading,
  type GenerationInputDraftOp,
  type GenerationInputsDraftController,
} from "../../generation";
import { generationSessionService } from "../../generation/services/GenerationSessionService";
import { projectGenerationSession } from "./generationSessionProjection";
import {
  boundedId,
  boundedItemOptions,
  boundedOrdinal,
  boundedTextValue,
  boundedWidgetValue,
  createExtensionTransactionPort,
} from "./extensionGenerationTransactionPort";
import { PUBLIC_FAILURE_CODES } from "./ExtensionGenerationBridge";
import type {
  ExtensionApiScope,
  ExtensionGenerationDraftCommitReading,
  ExtensionGenerationDraftOp,
  ExtensionGenerationInputsDraft,
  ExtensionGenerationInputsDraftRequest,
  ExtensionGenerationTransactionResult,
} from "../types";

/**
 * The staged inputs editor, as an extension may hold one.
 *
 * Built per activation by `api.generation`, not published as a component on
 * `runtime`. The reason is structural: `runtime` is a module-level singleton
 * with no scope in reach, and a draft *writes to the session*, so it has to be
 * owner-bound — refused once the activation ends, and disposed with it. A
 * renderer can live on `runtime` because every mutation it triggers goes
 * through a controller that already has a scope.
 */

/**
 * Native controller behind each published one.
 *
 * A `WeakMap` rather than a field on the public object: the SDK type stays
 * opaque, so package code cannot reach the unprojected host snapshots or the
 * native transaction, and the renderer on `runtime` can still resolve the real
 * draft from the handle it is given.
 */
const nativeDrafts = new WeakMap<
  ExtensionGenerationInputsDraft,
  GenerationInputsDraftController
>();

export function nativeDraftFor(
  candidate: unknown,
): GenerationInputsDraftController | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  return (
    nativeDrafts.get(candidate as ExtensionGenerationInputsDraft) ?? null
  );
}

/**
 * Translate one published op into the host's own.
 *
 * Bounded through the *same* helpers the transaction port uses, not a lighter
 * copy of them. A staged op is compiled into those very writes at commit, so a
 * weaker check here would let an oversize prompt or a non-finite widget value
 * be staged, shown in the editor, and committed — while the equivalent direct
 * write refused it. Payloads are also detached on the way through: a caller
 * that keeps mutating what it passed would otherwise change what commits, with
 * no notification and nothing on screen to show it moved.
 */
function toNativeOp(op: ExtensionGenerationDraftOp): GenerationInputDraftOp {
  switch (op?.kind) {
    case "setText":
      return {
        kind: "setText",
        inputId: boundedId(op.inputId, "Generation input IDs"),
        value: boundedTextValue(op.value),
      };
    case "holdText":
      return {
        kind: "holdText",
        inputId: boundedId(op.inputId, "Generation input IDs"),
      };
    case "attachAsset": {
      const itemOptions = boundedItemOptions(op.itemOptions);
      return {
        kind: "attachAsset",
        inputId: boundedId(op.inputId, "Generation input IDs"),
        assetId: boundedId(op.assetId, "Asset IDs"),
        ...(itemOptions === undefined ? {} : { itemOptions }),
      };
    }
    case "replaceMedia": {
      const itemOptions = boundedItemOptions(op.itemOptions);
      return {
        kind: "replaceMedia",
        inputId: boundedId(op.inputId, "Generation input IDs"),
        assetId: boundedId(op.assetId, "Asset IDs"),
        at: boundedOrdinal(op.at),
        ...(itemOptions === undefined ? {} : { itemOptions }),
      };
    }
    case "removeMedia":
      return {
        kind: "removeMedia",
        inputId: boundedId(op.inputId, "Generation input IDs"),
        slotId: boundedId(op.slotId, "Generation slot IDs"),
      };
    case "moveMedia":
      return {
        kind: "moveMedia",
        inputId: boundedId(op.inputId, "Generation input IDs"),
        fromOrdinal: boundedOrdinal(op.fromOrdinal),
        toOrdinal: boundedOrdinal(op.toOrdinal),
      };
    case "setMediaOption":
      if (typeof op.value !== "boolean") {
        throw new Error("Generation media options take boolean values.");
      }
      return {
        kind: "setMediaOption",
        inputId: boundedId(op.inputId, "Generation input IDs"),
        slotId: boundedId(op.slotId, "Generation slot IDs"),
        optionId: boundedId(op.optionId, "Generation option IDs"),
        value: op.value,
      };
    case "setWidget":
      return {
        kind: "setWidget",
        nodeId: boundedId(op.nodeId, "Node IDs"),
        param: boundedId(op.param, "Widget names"),
        value: boundedWidgetValue(op.value),
      };
    default:
      throw new Error(
        `Unknown generation draft operation '${String((op as { kind?: unknown })?.kind)}'.`,
      );
  }
}

/**
 * The projected inputs, as the SDK publishes them.
 *
 * Run back through the same projection the session uses, so a staged input and
 * a committed one are described identically — including the truncation limits,
 * which a package would otherwise see applied to some of its inputs and not
 * others.
 */
function projectDraftInputs(
  inputs: readonly unknown[],
): ExtensionGenerationInputsDraft extends never
  ? never
  : ReturnType<typeof projectGenerationSession>["session"]["inputs"] {
  const snapshot = generationSessionService.getSnapshot();
  if (!snapshot) return [];
  return projectGenerationSession({
    ...snapshot,
    inputs: inputs as typeof snapshot.inputs,
  }).session.inputs;
}

/**
 * A map a package can read but not write.
 *
 * `ReadonlyMap` is a compile-time claim only, and the published reading is
 * cached — so handing over a plain `Map` lets a package mutate the very object
 * every later `getState` returns. Refusing the writes keeps the published state
 * meaning what the host says it means.
 */
function readOnlyMap<T>(source: ReadonlyMap<string, T>): ReadonlyMap<string, T> {
  // Values are detached, not just the map. A widget value can be an object, and
  // the staged one is the host's — handing the live reference over lets a
  // package change what commits by mutating what it read, with no `stage` call
  // and nothing notified. Frozen as well as cloned so the attempt is loud.
  const copy = new Map<string, T>();
  for (const [key, value] of source) copy.set(key, detachJson(value));
  const refuse = () => {
    throw new Error("A generation draft's widget values are read-only.");
  };
  // A delegating view, not a prototype over the Map: Map's methods need its
  // internal slot on `this`, so anything inheriting from an instance throws
  // "incompatible receiver" on the first `get`.
  const view = {
    get size() {
      return copy.size;
    },
    get: (key: string) => copy.get(key),
    has: (key: string) => copy.has(key),
    keys: () => copy.keys(),
    values: () => copy.values(),
    entries: () => copy.entries(),
    forEach: (
      callback: (value: T, key: string, map: ReadonlyMap<string, T>) => void,
      thisArg?: unknown,
    ) =>
      copy.forEach((value, key) => {
        // The facade, never `copy` — `Map.forEach` hands its callback the
        // backing map as the third argument, which would pass out the very
        // object this wrapper exists to keep in.
        callback.call(thisArg, value, key, view as ReadonlyMap<string, T>);
      }),
    [Symbol.iterator]: () => copy[Symbol.iterator](),
    [Symbol.toStringTag]: "Map",
    set: refuse,
    delete: refuse,
    clear: refuse,
  };
  return Object.freeze(view) as unknown as ReadonlyMap<string, T>;
}

/**
 * A deeply frozen copy of a finite-JSON value.
 *
 * Widget values reach the host through `boundedWidgetValue`, which already
 * re-parses them, so the staged value is the host's own object — which is
 * exactly why the *published* one has to be a further copy.
 */
function detachJson<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => detachJson(entry))) as T;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = detachJson(entry);
  }
  return Object.freeze(clone) as T;
}

/**
 * The commit reading as the SDK publishes it: inputs through the session's
 * own projection, widget values detached and write-refusing, all frozen — the
 * caller numbers its prompt from this and must not be able to change it.
 */
function projectCommitReading(
  reading: GenerationDraftCommitReading,
): ExtensionGenerationDraftCommitReading {
  return Object.freeze({
    inputs: projectDraftInputs(reading.inputs),
    widgetValues: readOnlyMap(reading.widgetValues) as ReadonlyMap<
      string,
      never
    >,
    workflow: Object.freeze({ ...reading.workflow }),
  });
}

function publicResult(
  result: ReturnType<GenerationInputsDraftController["commit"]>,
): ExtensionGenerationTransactionResult {
  if (result.ok) {
    return { ok: true, changed: result.changed, label: result.label };
  }
  return {
    ok: false,
    code: PUBLIC_FAILURE_CODES[result.code] ?? "callback_failed",
    message: result.message,
    label: result.label,
  };
}

/**
 * What every draft reads once its activation has ended.
 *
 * Shared and frozen: the reading carries nothing activation-specific, and one
 * value means a package holding two dead drafts cannot tell them apart by
 * identity — which is correct, because there is nothing left to distinguish.
 */
const DISPOSED_PUBLISHED_STATE: ReturnType<
  ExtensionGenerationInputsDraft["getState"]
> = Object.freeze({
  status: "disposed" as const,
  inputs: Object.freeze([]) as ReturnType<
    ExtensionGenerationInputsDraft["getState"]
  >["inputs"],
  widgetValues: readOnlyMap(new Map()) as ReadonlyMap<string, never>,
  hasDraftChanges: false,
  hasConflict: false,
  canCommit: false,
  error: null,
});

export function createScopedInputsDraft(
  scope: ExtensionApiScope,
  request: ExtensionGenerationInputsDraftRequest,
): ExtensionGenerationInputsDraft | null {
  if (scope.signal.aborted) return null;
  const inputIds = (request?.inputIds ?? []).map((id) =>
    boundedId(id, "Generation input IDs"),
  );
  // The SDK names it `widget`, the draft names it `param`; same thing.
  const widgetTargets = (request?.widgetTargets ?? []).map((target) => ({
    nodeId: boundedId(target?.nodeId, "Node IDs"),
    param: boundedId(target?.widget, "Widget names"),
  }));
  const holdInputIds = (request?.holdInputIds ?? []).map((id) =>
    boundedId(id, "Generation input IDs"),
  );
  const native = createGenerationInputsDraft({
    inputIds,
    widgetTargets,
    holdInputIds,
  });

  /**
   * The published reading, cached against the native one it was built from.
   *
   * `getState` feeds `useSyncExternalStore`, which compares snapshot identity —
   * a freshly projected object per call is an infinite render loop, not a
   * performance question. The native reading is already identity-stable between
   * notifications, so it is the cache key.
   */
  let publishedState: ReturnType<
    ExtensionGenerationInputsDraft["getState"]
  > | null = null;
  let publishedFrom: ReturnType<
    GenerationInputsDraftController["getSnapshot"]
  > | null = null;
  const published: ExtensionGenerationInputsDraft = {
    getState: () => {
      /**
       * Terminal the moment the activation ends, in **every** field.
       *
       * An early return, not a `status` computed alongside the rest: the scope
       * aborts before the owned resources are disposed, so during that window
       * the native controller is still subscribed and still reading a live
       * session. Deriving only `status` from `aborted` published a reading that
       * called itself `disposed` while carrying non-empty `inputs` that went on
       * changing whenever the panel republished — which is precisely the thing
       * `status` was added to make impossible to observe.
       *
       * One frozen value, so identity is stable for `useSyncExternalStore` and
       * a package cannot mutate what it read. The native controller is disposed
       * moments later through `scope.own`; this only guarantees that nobody can
       * see it in between.
       */
      if (scope.signal.aborted) return DISPOSED_PUBLISHED_STATE;
      const reading = native.getSnapshot();
      if (publishedState && publishedFrom === reading) {
        return publishedState;
      }
      publishedFrom = reading;
      publishedState = {
        status: reading.status,
        inputs: projectDraftInputs(reading.inputs),
        // Detached and write-refusing, not the host's own map: sharing it lets
        // a package change what the renderer displays without staging anything.
        widgetValues: readOnlyMap(reading.widgetValues) as ReadonlyMap<
          string,
          never
        >,
        hasDraftChanges: reading.hasDraftChanges,
        hasConflict: reading.hasConflict,
        canCommit: reading.canCommit,
        error: reading.error,
      };
      return publishedState;
    },
    subscribe: (listener) => {
      if (scope.signal.aborted) return () => undefined;
      return native.subscribe(() => {
        // Silenced once the activation ends, matching the rest of the API: a
        // component still mounted over a disposed draft sees one stable value
        // rather than a session it can no longer write moving underneath it.
        if (scope.signal.aborted) return;
        try {
          listener();
        } catch (error) {
          scope.report(
            "error",
            "A generation draft subscriber threw.",
            error,
          );
        }
      });
    },
    stage: (op) => {
      if (scope.signal.aborted) return;
      native.stage(toNativeOp(op));
    },
    revert: () => {
      if (scope.signal.aborted) return;
      native.revert();
    },
    commit: (label, additionalWrites) => {
      if (scope.signal.aborted) {
        return {
          ok: false,
          code: "unavailable",
          message: "The extension activation has ended.",
          label: typeof label === "string" ? label.trim() : "",
        };
      }
      // Passed on only when the caller gave one: the host takes a supplied
      // callback as a promise to resolve against the commit reading, and
      // holds the transaction to it.
      return publicResult(
        native.commit(
          label,
          additionalWrites
            ? (session, reading) =>
                // The same port every other extension write crosses, so a bad
                // id or an oversize value is refused here and rolls the whole
                // staged commit back rather than reaching the store.
                //
                // Returned, not called and discarded: the session refuses an
                // async callback, and it can only see one if the value travels
                // back through both this wrapper and the host controller.
                additionalWrites(
                  createExtensionTransactionPort(session),
                  projectCommitReading(reading),
                )
            : undefined,
        ),
      );
    },
    dispose: () => native.dispose(),
  };

  nativeDrafts.set(published, native);
  // Owned by the activation, so a retained draft cannot outlive the extension
  // that opened it and keep writing to the panel.
  scope.own({ dispose: () => native.dispose() });
  return published;
}
