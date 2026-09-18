/*
 * How this API reports failure, so a caller can predict it without reading
 * every signature:
 *
 * - Thrown errors are your mistakes. Malformed input, an unknown or unowned
 *   ID, a contribution registered twice, a call after deactivation. These are
 *   bugs in the extension and should surface loudly in development rather than
 *   be caught and swallowed.
 * - Returned results are the editor's answer. A transaction the host refused,
 *   a command whose `when` is false, an `openView` the user has hidden. These
 *   are ordinary states of a running editor, so they come back as typed values
 *   — `ExtensionTimelineTransactionResult`, `false` — worth branching on
 *   rather than treating as errors.
 * - Diagnostics are advisory. A shadowed keybinding or an orphaned menu
 *   placement leaves the extension running; the host reports through
 *   `context.logger` and the extension manager instead of failing activation.
 *
 * Asynchronous work follows the same split: a rejected promise is a mistake, a
 * resolved typed value is an answer.
 */

/**
 * Contribution metadata reserved for the trusted/restricted dispatch split.
 * SDK 1 records this value but does not enforce isolation.
 */
export type ExtensionExecutionMode = "trusted" | "restricted";

export type ExtensionLifecycleResult = void | ExtensionResource;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Opaque, versioned data owned by one extension contribution. */
export interface ExtensionPayload {
  extensionId: string;
  typeId: string;
  schemaVersion: number;
  data: JsonValue;
  /** Host-readable dependencies retained even when the provider is missing. */
  assetReferences?: readonly string[];
}

export interface ExtensionPayloadMigration {
  schemaVersion: number;
  data: JsonValue;
}

export interface ExtensionBackendArtifact {
  readonly artifactId: string;
  readonly role: "input" | "output";
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
}

export type ExtensionBackendJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ExtensionBackendJobReadiness {
  readonly ready: boolean;
  readonly message: string;
  readonly details?: JsonValue;
}

export interface ExtensionBackendJobType {
  readonly id: string;
  readonly label: string;
  readonly timeoutSeconds: number;
  /**
   * This job holds the machine's GPU for the whole of its run, so it waits
   * behind SAM2, SAM-Audio, a local ComfyUI prompt, and anything another
   * extension is running. It stays `queued` while it waits, and its execution
   * timeout starts only once it is admitted.
   */
  readonly usesLocalGpu: boolean;
  readonly readiness: ExtensionBackendJobReadiness;
}

export interface ExtensionBackendJobDiagnostic {
  readonly level: "debug" | "info" | "warning" | "error";
  readonly message: string;
  readonly timestamp: number;
  readonly detail?: JsonValue;
}

export interface ExtensionBackendJobSnapshot {
  readonly jobId: string;
  readonly jobType: string;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly status: ExtensionBackendJobStatus;
  readonly progress: number;
  readonly message: string;
  readonly cancelRequested: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly result?: JsonValue;
  readonly error?: string;
  readonly artifacts: readonly ExtensionBackendArtifact[];
  readonly diagnostics: readonly ExtensionBackendJobDiagnostic[];
}

export interface ExtensionBackendArtifactUploadOptions {
  readonly filename: string;
  readonly contentType?: string;
  readonly signal?: AbortSignal;
}

export interface ExtensionBackendJobWaitOptions {
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly onProgress?: (snapshot: ExtensionBackendJobSnapshot) => void;
}

/** Owner-bound frontend client for one trusted extension's backend half. */
export interface ExtensionBackendApi {
  /** Raw trusted escape hatch, always relative to this extension's `/api`. */
  call(path: string, init?: RequestInit): Promise<Response>;
  listJobs(options?: { readonly signal?: AbortSignal }): Promise<
    readonly ExtensionBackendJobType[]
  >;
  uploadArtifact(
    content: Blob,
    options: ExtensionBackendArtifactUploadOptions,
  ): Promise<ExtensionBackendArtifact>;
  submitJob(
    jobType: string,
    input: JsonValue,
    artifactIds?: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<ExtensionBackendJobSnapshot>;
  getJob(
    jobId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ExtensionBackendJobSnapshot>;
  cancelJob(
    jobId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ExtensionBackendJobSnapshot>;
  waitForJob(
    jobId: string,
    options?: ExtensionBackendJobWaitOptions,
  ): Promise<ExtensionBackendJobSnapshot>;
  getArtifact(
    artifactId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Blob>;
  getArtifactUrl(artifactId: string): string;
}

/*
 * Runtime capabilities: whether the machine can actually run a model runtime,
 * and why not when it cannot.
 *
 * A backend extension registers a capability through the registrar on its
 * `BackendExtensionContext`; everything below is the frontend half of that
 * registration. The payload shapes mirror the host's own
 * `/app/runtime-capabilities` contract exactly, because the point of this
 * namespace is that an extension presents the same readiness the Runtime
 * Diagnostics panel presents, rather than inventing a second definition of
 * "available".
 */

/**
 * Every failure the backend can report. Closed on purpose: an unrecognised
 * runtime failure is classified as `runtime_load_failed` rather than given a
 * new code, so a switch over this union stays total.
 */
export type ExtensionCapabilityFailureCode =
  | "python_version_unsupported"
  | "package_missing"
  | "package_import_failed"
  | "dependency_incompatible"
  | "dependency_download_failed"
  | "model_missing"
  | "model_invalid"
  | "config_missing"
  | "out_of_memory"
  | "runtime_load_failed"
  | "device_unavailable"
  | "cache_unwritable"
  | "authentication_required";

export type ExtensionCapabilityState =
  | "unavailable"
  | "blocked"
  | "available_unverified"
  | "ready"
  | "degraded"
  | "checking";

/** How far the evidence reaches. `null` means not even discovery passed. */
export type ExtensionCapabilityVerificationStage =
  | "discovered"
  | "environment"
  | "loaded"
  | "operational";

/** `skipped` means the check could not be carried out — never that it passed. */
export type ExtensionCapabilityCheckStatus = "pass" | "warn" | "fail" | "skipped";

export type ExtensionCapabilityRemediationKind =
  | "command"
  | "download"
  | "settings"
  | "docs";

export interface ExtensionCapabilityRemediation {
  readonly kind: ExtensionCapabilityRemediationKind;
  readonly summary: string;
  readonly command?: string;
  readonly url?: string;
  readonly requiresRestart: boolean;
}

export interface ExtensionCapabilityCheck {
  readonly id: string;
  readonly status: ExtensionCapabilityCheckStatus;
  readonly stage: ExtensionCapabilityVerificationStage;
  readonly summary: string;
  readonly code?: ExtensionCapabilityFailureCode;
  readonly detail?: string;
  readonly remediation?: ExtensionCapabilityRemediation;
}

export interface ExtensionCapabilityDevice {
  readonly requested: string;
  readonly resolved: string | null;
  /** False while `resolved` is only what this configuration should resolve to. */
  readonly proven: boolean;
  readonly fallback: boolean;
}

export interface ExtensionCapabilityFailureRecord {
  readonly code: ExtensionCapabilityFailureCode;
  readonly summary: string;
  readonly stage: ExtensionCapabilityVerificationStage;
  readonly occurredAt: string;
  readonly detail?: string;
}

/** One capability as the backend reports it. */
export interface ExtensionCapabilitySnapshot {
  readonly id: string;
  readonly label: string;
  readonly state: ExtensionCapabilityState;
  /** The single field a feature surface gates on. */
  readonly canAttempt: boolean;
  readonly verifiedThrough: ExtensionCapabilityVerificationStage | null;
  readonly checkedAt: string;
  readonly selectedModel: string | null;
  readonly device: ExtensionCapabilityDevice | null;
  /** Backend-defined rows: whatever this capability's discovery reports. */
  readonly models: readonly Readonly<Record<string, unknown>>[];
  readonly checks: readonly ExtensionCapabilityCheck[];
  readonly lastFailure: ExtensionCapabilityFailureRecord | null;
  /** Present after this backend process has loaded the runtime successfully. */
  readonly lastSuccessfulLoad?: string | null;
}

/**
 * Whether the host has an answer yet — distinct from what the answer is.
 *
 * `checking` matters: a cold read runs out-of-process import probes and can
 * take upwards of ten seconds, so a panel must say "still looking" rather than
 * "unavailable" while the first read is in flight.
 */
export type ExtensionCapabilityReadStatus =
  | "idle"
  | "checking"
  | "ready"
  | "error";

/**
 * The host's own projection of a capability, as its feature surfaces consume
 * it. `read` gives you this rather than making you re-derive which check
 * explains the failure — the derivation is the part two implementations
 * disagree about.
 */
export interface ExtensionCapabilityView {
  /** Always the fully namespaced id, whichever form you asked with. */
  readonly id: string;
  readonly capability: ExtensionCapabilitySnapshot | null;
  /** True while the first answer is still being fetched. */
  readonly checking: boolean;
  /** Unknown is not available: until something is known, nothing is offered. */
  readonly canAttempt: boolean;
  readonly verifiedThrough: ExtensionCapabilityVerificationStage | null;
  /** The check that explains why not, when something is known to be failing. */
  readonly failure: ExtensionCapabilityCheck | null;
  readonly failureCode: ExtensionCapabilityFailureCode | null;
  /** A message for surfaces with one line to spend. */
  readonly message: string | null;
  /** A recheck of this capability is in flight. */
  readonly rechecking: boolean;
  /** A runtime load test of this capability is queued or running. */
  readonly testing: boolean;
}

/**
 * How a recheck or a load test ended.
 *
 * A failed operation is an ordinary state of a running editor — the backend
 * was unreachable, the probe job failed — so it comes back as a value rather
 * than a rejection. `view` is the capability as it stands afterwards, which on
 * failure is the *previous* reading: a failed recheck does not erase what was
 * last known, and reading `view` alone would therefore look like success.
 * `cancelled` means nobody is waiting any more (your extension deactivated, or
 * the user stopped the test); the backend job may still be running.
 */
export type ExtensionCapabilityOperationResult =
  | { readonly ok: true; readonly view: ExtensionCapabilityView }
  | {
      readonly ok: false;
      readonly status: "failed" | "cancelled";
      readonly error: string | null;
      readonly view: ExtensionCapabilityView;
    };

export interface ExtensionCapabilityNoticeProps {
  /** Your own capability's local name or namespaced id — see `host`. */
  readonly capabilityId: string;
  /**
   * Render a *host* capability's notice (`"sam2"`, `"comfyui"`, …) instead of
   * one of yours, for a feature that depends on one. Read-only either way.
   */
  readonly host?: boolean;
  /** Shown when the capability is unavailable for a reason no check names. */
  readonly fallbackMessage?: string | null;
  /** Drops the title line, for a notice inside an already-titled panel. */
  readonly dense?: boolean;
  /**
   * Your own model-download UI, as a React node. Rendered only for missing or
   * incomplete model files — the one class of failure it can actually fix.
   * Weights are the extension's to distribute, so this is where that lands.
   */
  readonly downloadSurface?: unknown;
}

/**
 * The host's remediation UI, as a React component you render in your own tree.
 * It reads the capability itself and renders nothing when there is nothing
 * wrong, so it can sit unconditionally above a feature's controls.
 *
 * For a missing or broken Python package it offers to *run* the install, not
 * only print it — built from the `install_target` your descriptor declared,
 * shown in full before it runs, and followed by a prompt to restart the
 * backend. Nothing about the command comes from this component or from your
 * extension's UI: the host derives it from your registered descriptor, so what
 * you declared at registration is the whole of what can be installed.
 *
 * Render it through the host's React, which is what your components are built
 * with anyway:
 *
 * ```ts
 * const React = api.runtime.react;
 * React.createElement(api.capabilities.FailureNotice, { capabilityId: "tracker" })
 * ```
 *
 * The return type is `unknown` because this contract does not name React's
 * types; `createElement` accepts it as-is.
 */
export type ExtensionCapabilityNoticeComponent = (
  props: ExtensionCapabilityNoticeProps,
) => unknown;

/**
 * Owner-bound `api.capabilities`: read your backend half's readiness, follow
 * it, ask for a recheck or a load test, and render the host's own remediation.
 *
 * **Scope.** Every method here addresses *your* capabilities, by local name
 * (`"tracker"`) or namespaced id (`"acme.tracking:tracker"`) — a bare name is
 * always yours, so a host capability added in a later release can never
 * silently retarget it, and a local name of `"sam2"` stays yours. Host
 * capabilities are read through `getHost`/`readHost`: knowing whether SAM2 is
 * available before offering a feature is a legitimate, read-only ask, but only
 * an owner may recheck or test one. Another extension's capability is neither
 * readable nor writable and throws.
 *
 * **Snapshots are detached.** Everything returned is a deep-frozen copy, so a
 * capability you are holding never changes under you and nothing you do to it
 * can reach the editor's own diagnostics.
 */
export interface ExtensionCapabilityApi {
  /** Your own capabilities, in registration order. Empty until first read. */
  list(): readonly ExtensionCapabilitySnapshot[];
  /** One capability as reported, or `null` when nothing is known of it yet. */
  get(capabilityId: string): ExtensionCapabilitySnapshot | null;
  /** The same capability, projected the way the host's own surfaces read it. */
  read(capabilityId: string): ExtensionCapabilityView;
  /** A host capability as reported (`"sam2"`, `"comfyui"`, …), read-only. */
  getHost(capabilityId: string): ExtensionCapabilitySnapshot | null;
  /** A host capability, projected as `read` projects your own. Read-only. */
  readHost(capabilityId: string): ExtensionCapabilityView;
  /** Whether the host has an answer yet; see `ExtensionCapabilityReadStatus`. */
  getStatus(): ExtensionCapabilityReadStatus;
  /**
   * Start the host's lazy first read, and resolve once it has settled.
   * Concurrent callers — yours and the host's own panels — join one request.
   */
  ensureLoaded(): Promise<void>;
  /** Fires whenever any capability's reported state changes. */
  subscribe(listener: () => void): () => void;
  getRevision(): number;
  /**
   * Re-run one of your capabilities' checks, discarding the cached probes.
   * Cheap: it never loads the runtime. Throws for a capability you do not own.
   * A second call while one is running joins it rather than starting another.
   */
  recheck(capabilityId: string): Promise<ExtensionCapabilityOperationResult>;
  /**
   * Load one of your runtimes for real and record what happened — the host's
   * "Test runtime" action. Expensive, and the only thing that can raise
   * `verifiedThrough` to `"loaded"`. Throws for a capability you do not own,
   * and resolves `cancelled` if your extension deactivates while it runs.
   */
  test(capabilityId: string): Promise<ExtensionCapabilityOperationResult>;
  /** The host's remediation UI; see `ExtensionCapabilityNoticeComponent`. */
  readonly FailureNotice: ExtensionCapabilityNoticeComponent;
}

/** A point in project/canvas coordinates. */
export interface ExtensionPoint2D {
  readonly x: number;
  readonly y: number;
}

/**
 * An arbitrary scalar animation source owned by an extension. Unlike a
 * keyframe interpolation strategy, a source may be procedural and need not
 * expose control points at all.
 */
export interface ExtensionScalarSourceParameter {
  readonly type: "extension-scalar";
  readonly source: ExtensionPayload;
}

/** One scalar keyframe. `outgoing` owns the following segment's mathematics. */
export interface ExtensionScalarKeyframe {
  readonly time: number;
  readonly value: number;
  readonly outgoing?: ExtensionPayload;
}

/**
 * Host-structured keyframes with extension-owned, versioned segment data.
 * Every non-final keyframe must identify an outgoing interpolation provider.
 */
export interface ExtensionKeyframedScalarParameter {
  readonly type: "extension-keyframed-scalar";
  readonly keyframes: readonly ExtensionScalarKeyframe[];
}

export type ExtensionScalarValue =
  | number
  | ExtensionScalarSourceParameter
  | ExtensionKeyframedScalarParameter;

/** Arbitrary 2D geometry plus an independently extensible progress source. */
export interface ExtensionSpatialPathParameter {
  readonly type: "extension-path2d";
  readonly geometry: ExtensionPayload;
  readonly timing: ExtensionScalarValue;
}

export interface ExtensionAnimationDataMigration {
  readonly schemaVersion: number;
  readonly data: JsonValue;
}

export interface ExtensionScalarSampleContext {
  readonly durationTicks?: number;
  readonly extrapolate: boolean;
}

/** Optional mapping needed when a scalar source is used as a speed factor. */
export interface ExtensionScalarTimeMap {
  outputToInput(outputTime: number, extrapolate: boolean): number;
  inputToOutput(inputTime: number): number;
}

export interface ExtensionCompiledScalarSource extends ExtensionDisposable {
  sample(time: number, context: ExtensionScalarSampleContext): number;
  derivative?(
    time: number,
    context: ExtensionScalarSampleContext,
  ): number;
  /** Deliberately opt-in: not every scalar function is a valid time warp. */
  readonly timeMap?: ExtensionScalarTimeMap;
}

export interface ExtensionScalarRemap {
  readonly timeScale: number;
  readonly timeOffset: number;
  readonly valueScale: number;
  readonly valueOffset: number;
}

export interface ExtensionAnimationEditorDomain {
  readonly minTime: number;
  readonly duration: number;
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly softMinValue?: number;
  readonly softMaxValue?: number;
}

export interface ExtensionScalarSourceEditorProps {
  readonly value: ExtensionScalarSourceParameter;
  readonly domain: ExtensionAnimationEditorDomain;
  readonly sample: (time: number) => number;
  /** The host wraps this callback in its normal preview/undo transaction. */
  readonly onChange: (value: ExtensionScalarSourceParameter) => void;
}

export interface ExtensionScalarSourceDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly label: string;
  readonly schemaVersion: number;
  readonly defaultData: JsonValue;
  validate(data: JsonValue, schemaVersion: number): void;
  migrate?(
    data: JsonValue,
    fromSchemaVersion: number,
  ): ExtensionAnimationDataMigration;
  compile(
    data: JsonValue,
    schemaVersion: number,
    context: Readonly<{ ticksPerSecond: number }>,
  ): ExtensionCompiledScalarSource;
  /** Required for reversal/retiming of persisted procedural source data. */
  remap?(
    data: JsonValue,
    schemaVersion: number,
    remap: ExtensionScalarRemap,
  ): ExtensionAnimationDataMigration;
  /** Arbitrary trusted React editor, isolated by a host error boundary. */
  readonly editor?: (props: ExtensionScalarSourceEditorProps) => unknown;
}

export interface ExtensionScalarSourceRegistration extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionScalarSourceApi {
  register(
    definition: ExtensionScalarSourceDefinition,
  ): ExtensionScalarSourceRegistration;
}

export interface ExtensionInterpolationCompileInput {
  readonly keyframes: readonly ExtensionScalarKeyframe[];
  readonly segmentIndex: number;
  readonly data: JsonValue;
  readonly schemaVersion: number;
}

export interface ExtensionCompiledInterpolationSegment
  extends ExtensionDisposable {
  sample(time: number): number;
  derivative?(time: number): number;
}

export interface ExtensionInterpolationEditorProps {
  readonly value: ExtensionKeyframedScalarParameter;
  readonly segmentIndex: number;
  readonly domain: ExtensionAnimationEditorDomain;
  readonly sample: (time: number) => number;
  readonly onChange: (value: ExtensionKeyframedScalarParameter) => void;
}

/** Mathematics and optional trusted UI for one keyframe segment strategy. */
export interface ExtensionInterpolationDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly label: string;
  readonly schemaVersion: number;
  readonly defaultData: JsonValue;
  validate(data: JsonValue, schemaVersion: number): void;
  migrate?(
    data: JsonValue,
    fromSchemaVersion: number,
  ): ExtensionAnimationDataMigration;
  compile(
    input: ExtensionInterpolationCompileInput,
  ): ExtensionCompiledInterpolationSegment;
  /**
   * Remaps provider-owned handles/coefficients when the host reverses or
   * retimes a track. Omit it to make that edit fail closed.
   */
  remap?(
    input: ExtensionInterpolationCompileInput,
    remap: ExtensionScalarRemap,
  ): ExtensionAnimationDataMigration;
  readonly editor?: (props: ExtensionInterpolationEditorProps) => unknown;
}

export interface ExtensionInterpolationRegistration
  extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionInterpolationApi {
  register(
    definition: ExtensionInterpolationDefinition,
  ): ExtensionInterpolationRegistration;
}

export interface ExtensionSpatialPathBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ExtensionCompiledSpatialPath extends ExtensionDisposable {
  /** Random-access sampling; progress normally lies in [0, 1]. */
  pointAt(progress: number): ExtensionPoint2D;
  tangentAt?(progress: number): ExtensionPoint2D;
  getBounds?(): ExtensionSpatialPathBounds;
  getLength?(): number;
  pointAtDistance?(distance: number): ExtensionPoint2D;
  hitTest?(point: ExtensionPoint2D, tolerance: number): boolean;
}

export interface ExtensionSpatialPathEditorProps {
  readonly value: ExtensionSpatialPathParameter;
  readonly domain: ExtensionAnimationEditorDomain;
  readonly currentTime: number;
  readonly onChange: (value: ExtensionSpatialPathParameter) => void;
}

export interface ExtensionSpatialPathOverlayParameters {
  readonly value: ExtensionSpatialPathParameter;
  readonly currentTime: number;
  readonly duration: number;
  readonly selected: boolean;
}

export interface ExtensionSpatialPathOverlayContext {
  readonly viewport: Readonly<{
    width: number;
    height: number;
    projectWidth: number;
    projectHeight: number;
  }>;
}

export type ExtensionTrustedSpatialPathOverlayInstance =
  ExtensionTrustedPixiObjectInstance<
    ExtensionSpatialPathOverlayParameters,
    ExtensionSpatialPathOverlayContext
  >;

/** Geometry, manipulation operations, and optional trusted editor surfaces. */
export interface ExtensionSpatialPathDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly label: string;
  readonly schemaVersion: number;
  readonly defaultData: JsonValue;
  validate(data: JsonValue, schemaVersion: number): void;
  migrate?(
    data: JsonValue,
    fromSchemaVersion: number,
  ): ExtensionAnimationDataMigration;
  compile(
    data: JsonValue,
    schemaVersion: number,
  ): ExtensionCompiledSpatialPath;
  /** Omit to make host reversal fail closed for this geometry. */
  reverse?(
    data: JsonValue,
    schemaVersion: number,
  ): ExtensionAnimationDataMigration;
  readonly editor?: (props: ExtensionSpatialPathEditorProps) => unknown;
  /** Optional host-slotted Pixi handles/overlay using the shared lifecycle. */
  readonly createOverlay?: () => ExtensionTrustedSpatialPathOverlayInstance;
}

export interface ExtensionSpatialPathRegistration extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionSpatialPathApi {
  register(
    definition: ExtensionSpatialPathDefinition,
  ): ExtensionSpatialPathRegistration;
}

export interface ExtensionAnimationApi {
  readonly scalarSources: ExtensionScalarSourceApi;
  readonly interpolations: ExtensionInterpolationApi;
  readonly spatialPaths: ExtensionSpatialPathApi;
}

/**
 * Persistence-only contract for one extension-owned payload type. Rendering
 * and editor UI are separate contribution contracts.
 */
export interface ExtensionPayloadProviderDefinition {
  id: string;
  apiVersion: 1;
  schemaVersion: number;
  validate(data: JsonValue, schemaVersion: number): void;
  migrate?(
    data: JsonValue,
    fromSchemaVersion: number,
  ): ExtensionPayloadMigration;
  getAssetReferences?(
    data: JsonValue,
    schemaVersion: number,
  ): readonly string[];
}

export interface ExtensionPayloadProviderRegistration
  extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionPayloadProviderApi {
  register(
    definition: ExtensionPayloadProviderDefinition,
  ): ExtensionPayloadProviderRegistration;
}

export interface ExtensionEntityAssetSnapshot {
  readonly id: string;
  readonly hash: string;
  readonly name: string;
  readonly type: "video" | "image" | "audio" | "lut";
  readonly src: string;
  /** Host-generated preview URL, when available. */
  readonly thumbnail?: string;
  readonly durationSeconds?: number;
  readonly fps?: number;
  readonly hasAudio?: boolean;
}

export interface ExtensionAssetIngestInput {
  readonly name: string;
  readonly type: "video" | "image" | "audio" | "lut";
  readonly blob: Blob;
}

export interface ExtensionAssetApi {
  list(): readonly ExtensionEntityAssetSnapshot[];
  get(assetId: string): ExtensionEntityAssetSnapshot | undefined;
  /** Loads browser-selected/project-backed bytes without exposing a file path. */
  readBlob(assetId: string): Promise<Blob>;
  /**
   * Copies bytes into the active project and resolves only after persistence.
   * A hash match returns the existing project asset rather than a sentinel.
   */
  ingest(input: ExtensionAssetIngestInput): Promise<ExtensionEntityAssetSnapshot>;
  /**
   * Fires after the asset library changes. Commit-grained and payload-free:
   * pull detached snapshots via `list()`/`get()`. Not a render-loop signal.
   */
  subscribe(listener: () => void): () => void;
  /** Monotonic change token matching `subscribe` notifications. */
  getRevision(): number;
}

// === Extension storage ===

/**
 * One key/value scope owned by this extension. Values are finite JSON,
 * cloned in both directions. Keys are non-empty strings up to 128 chars and
 * must not contain "/".
 */
export interface ExtensionKeyValueStore {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
  /**
   * Fires after this scope changes through this API. Writes made outside the
   * running frontend (e.g. by the extension's backend half to its local
   * scope) do not notify.
   */
  subscribe(listener: () => void): () => void;
  /** Monotonic change token matching `subscribe` notifications. */
  getRevision(): number;
}

/**
 * Extension-owned persistent state (extension-shell-surfaces plan §4).
 * Neither scope participates in undo history — timeline-coupled state
 * belongs in extension payloads, not storage.
 */
export interface ExtensionStorageApi {
  /** Per-machine, per-extension; survives project switches. */
  readonly local: ExtensionKeyValueStore;
  /**
   * Travels with the project; persisted beside the other project documents
   * and retained even while the extension is uninstalled. Null when no
   * project is open.
   */
  readonly project: ExtensionKeyValueStore | null;
}

export interface ExtensionEntityRenderParameters {
  /** Detached, provider-validated payload data for this frame. */
  readonly data: JsonValue;
  readonly schemaVersion: number;
}

export interface ExtensionEntityRenderContext {
  readonly entity: Readonly<{
    id: string;
    name: string;
    trackId: string;
    startTicks: number;
    durationTicks: number;
  }>;
  readonly frame: Readonly<{
    projectWidth: number;
    projectHeight: number;
    presentationTimeTicks: number;
    visualTimeTicks: number;
    sourceTimeTicks: number;
    fps: number;
  }>;
  /** The exact host renderer. This is intentionally powerful in trusted mode. */
  readonly renderer: object;
  readonly assets: Readonly<{
    get(assetId: string): ExtensionEntityAssetSnapshot | undefined;
  }>;
}

export type ExtensionTrustedEntityRenderableInstance =
  ExtensionTrustedPixiObjectInstance<
    ExtensionEntityRenderParameters,
    ExtensionEntityRenderContext
  >;

export interface ExtensionEntityInspectorProps {
  readonly entity: Readonly<{
    id: string;
    name: string;
    trackId: string;
    startTicks: number;
    durationTicks: number;
  }>;
  readonly data: JsonValue;
  readonly schemaVersion: number;
  /** Commits one owner-checked, undoable payload update. */
  updateData(data: JsonValue): ExtensionTimelineTransactionResult;
}

/**
 * Primary renderable-entity contract. It deliberately accepts any host-Pixi
 * Container subclass (Graphics, Sprite, custom containers, shader-backed
 * objects). The host owns its render slot, compositing, masks, transforms, and
 * final destruction; the extension owns its contents and update logic.
 */
export interface ExtensionTrustedEntityProviderDefinition
  extends ExtensionPayloadProviderDefinition {
  readonly kind: "trusted-pixi";
  readonly label: string;
  readonly timelineColor?: string;
  readonly defaultPayload: JsonValue;
  readonly createRenderable: () => ExtensionTrustedEntityRenderableInstance;
  /**
   * Optional cache key for the pixels produced by `update`. Return the same
   * string only when every provider-owned pixel input beyond the payload
   * (including time and asset hashes when used) is unchanged. The host always
   * includes payload data, schema, entity identity, and output dimensions.
   * Omitting this callback safely disables texture reuse for time-driven or
   * externally mutable renderers.
   */
  readonly getRenderSignature?: (
    parameters: ExtensionEntityRenderParameters,
    context: ExtensionEntityRenderContext,
  ) => string;
  /** Optional arbitrary React inspector rendered in a host-owned error boundary. */
  readonly inspector?: (props: ExtensionEntityInspectorProps) => unknown;
}

export interface ExtensionEntityProviderRegistration
  extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionEntityProviderApi {
  register(
    definition: ExtensionTrustedEntityProviderDefinition,
  ): ExtensionEntityProviderRegistration;
}

export interface ExtensionTimelineEntitySnapshot {
  readonly id: string;
  readonly trackId: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  readonly payload: ExtensionPayload;
}

export interface ExtensionTimelineTransformSnapshot {
  readonly id: string;
  readonly type: string;
  readonly isEnabled: boolean;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly keyframeTimes?: readonly number[];
  readonly templateId?: string;
  readonly filterName?: string;
}

/**
 * A boolean mask equation over a clip's masks, as the host stores it. Leaves
 * name masks by their clip-local ID, matching
 * `ExtensionTimelineMaskSnapshot.localId`.
 */
export type ExtensionMaskExpression =
  | {
      readonly kind: "mask";
      readonly maskId: string;
      /** The leaf stands for the complement of the mask. Absent when false. */
      readonly inverted?: true;
    }
  | {
      readonly kind: "operation";
      readonly operator: "union" | "intersect" | "subtract";
      readonly left: ExtensionMaskExpression;
      readonly right: ExtensionMaskExpression;
    };

/** How a clip's masks combine. */
export interface ExtensionMaskCompositionSnapshot {
  /**
   * Three distinct states, spelled out rather than encoded as null vs.
   * undefined so neither can be mistaken for the other:
   *
   * - `"auto"` — no equation was authored; the host unions the clip's masks.
   *   A clip can reach this state while still carrying a composition (edge
   *   transforms or a non-default algebra), so it is not the same as having
   *   no `maskComposition` at all.
   * - `"none"` — composed masking was explicitly turned off.
   * - an expression — the authored equation.
   *
   * Narrow with `typeof expression === "string"` before walking the tree.
   */
  readonly expression: ExtensionMaskExpression | "auto" | "none";
  /**
   * The separate on/off switch: false renders the clip unmasked while keeping
   * the equation intact, so it is reversible in a way `"none"` is not.
   */
  readonly isEnabled: boolean;
  /** Whether operations evaluate in coverage or inverse ("hole") space. */
  readonly algebra: "normal" | "inverse";
}

/** A source-time window of transparency carried on the clip. */
export interface ExtensionRangeMaskSnapshot {
  readonly id: string;
  readonly startSourceTicks: number;
  readonly endSourceTicks: number;
  readonly isActive: boolean;
  readonly name?: string;
}

export interface ExtensionTimelineClipSnapshot {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly trackId: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  readonly assetId?: string;
  /**
   * Source ticks trimmed from the head — the clip's in-point. Pair with
   * `sourceDurationTicks` to know how much media is left to trim into.
   */
  readonly sourceOffsetTicks: number;
  /** Full source length, or null for unbounded media (stills, adjustments). */
  readonly sourceDurationTicks: number | null;
  /**
   * Source span this clip covers, excluding speed. Comparing it with
   * `durationTicks` tells you the clip is retimed without re-deriving the
   * speed transform.
   */
  readonly croppedSourceDurationTicks: number;
  /** Per-clip audio mute. */
  readonly isMuted: boolean;
  /** Present when the clip is a placement of a composite. */
  readonly compositeId?: string;
  /** Present when the clip's masks carry an explicit equation. */
  readonly maskComposition?: ExtensionMaskCompositionSnapshot;
  readonly rangeMasks: readonly ExtensionRangeMaskSnapshot[];
  readonly transformations: readonly ExtensionTimelineTransformSnapshot[];
}

/**
 * One timeline track, in the project's visual order. Tracks are host-owned:
 * this is a read projection, and `trackId` values on clips and entities resolve
 * against it.
 */
export interface ExtensionTimelineTrackSnapshot {
  readonly id: string;
  /** Position in the project's track order, top to bottom. */
  readonly index: number;
  readonly label: string;
  /**
   * The content class a track accepts. Legacy tracks may carry no type, which
   * the host treats as `"visual"`; those report `null` rather than guessing.
   */
  readonly type: string | null;
  readonly isVisible: boolean;
  readonly isMuted: boolean;
  readonly isLocked: boolean;
}

export interface ExtensionTimelineMaskBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ExtensionTimelineMaskActiveRange {
  readonly startSourceTicks: number;
  readonly endSourceTicks: number;
}

export interface ExtensionTimelineMaskSnapshot {
  readonly id: string;
  readonly parentClipId: string;
  readonly localId: string;
  readonly name: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  readonly maskType: string;
  readonly maskMode: string;
  readonly maskInverted: boolean;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly assetId?: string;
  readonly paintedBounds?: ExtensionTimelineMaskBounds;
  readonly activeRange?: ExtensionTimelineMaskActiveRange;
  readonly transformations: readonly ExtensionTimelineTransformSnapshot[];
}

export interface ExtensionTimelineTransitionSnapshot {
  readonly id: string;
  readonly type: string;
  readonly outgoingClipId: string;
  readonly incomingClipId: string;
  readonly schemaVersion?: number;
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

export interface ExtensionTimelineTransformInput {
  readonly id?: string;
  readonly type: string;
  readonly isEnabled?: boolean;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly keyframeTimes?: readonly number[];
  readonly templateId?: string;
  readonly filterName?: string;
}

export interface ExtensionTimelineProjectSnapshot {
  /**
   * Width of the project's logical coordinate space, in stage pixels. This is
   * the space clip positions and paths are expressed in — not the size of a
   * rendered frame. It is fixed-height (1080) and so does not change with the
   * project's output resolution.
   */
  readonly width: number;
  /** Height of the logical coordinate space, in stage pixels. Always 1080. */
  readonly height: number;
  /**
   * Width in pixels of a frame this project renders — selection extraction,
   * project export and frame capture alike. Derived from the aspect ratio and
   * the project's output resolution, with the short edge pinned and both axes
   * even. Equals {@link width} only when the two conventions coincide, which
   * they do at 1080 in landscape and square, and never in portrait.
   */
  readonly outputWidth: number;
  /** Height in pixels of a rendered frame. See {@link outputWidth}. */
  readonly outputHeight: number;
  readonly fps: number;
  readonly fitMode: "contain" | "cover";
}

export interface ExtensionSourceDimensions {
  readonly width: number;
  readonly height: number;
}

export interface ExtensionTimelineEntityCreateInput {
  readonly name: string;
  readonly trackId?: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  readonly payload: ExtensionPayload;
}

export interface ExtensionTimelineTransitionCreateInput {
  /** Local transition contribution ID registered by this extension. */
  readonly transitionType: string;
  readonly outgoingClipId: string;
  readonly incomingClipId: string;
  readonly parameters?: Readonly<Record<string, JsonValue>>;
}

/** Creates one host-supported mask attached to an ordinary timeline clip. */
export interface ExtensionTimelineMaskCreateInput {
  /** Host mask type discovered through current host documentation. */
  readonly maskType: string;
  readonly name?: string;
  readonly mode?: "apply" | "preview";
  readonly inverted?: boolean;
  /** Host-owned mask parameters; currently finite positive baseWidth/baseHeight. */
  readonly parameters: Readonly<Record<string, JsonValue>>;
  /** Required for bitmap-backed mask types; ingest bytes through assets first. */
  readonly assetId?: string;
  readonly paintedBounds?: ExtensionTimelineMaskBounds;
  readonly activeRange?: ExtensionTimelineMaskActiveRange;
}

/**
 * Places one ordinary clip from a project asset. The host builds the clip from
 * the asset's own media properties; an extension supplies placement only.
 */
export interface ExtensionTimelineClipCreateInput {
  /** A project asset ID, from `assets.list()`/`get()`/`ingest()`. */
  readonly assetId: string;
  /** Optional override for the host's name (defaults to the asset's). */
  readonly name?: string;
  /**
   * Target track. Omit to let the host choose a compatible one, creating a
   * track when none fits. A named track must accept the asset's media class.
   */
  readonly trackId?: string;
  /**
   * Requested start. The host resolves overlaps exactly as it does for a user
   * drag — snapping off a neighbour's edge, refusing to land on top of one — so
   * the committed start may differ. Read it back with `listClips()`.
   */
  readonly startTicks: number;
}

/** Requested placement. Omitted fields keep their current value. */
export interface ExtensionTimelineClipPlacement {
  readonly startTicks?: number;
  readonly trackId?: string;
}

/**
 * Requested clip edges, in timeline ticks. Omitted edges are left alone.
 * Trimming changes which part of the source plays, unlike `moveClip`, which
 * slides the same content. The host clamps both edges to the media's own
 * bounds, the neighbouring clips, and the minimum clip duration.
 */
export interface ExtensionTimelineClipTrim {
  readonly startTicks?: number;
  readonly endTicks?: number;
}

/** Clip properties an extension may set. Omitted fields are left alone. */
export interface ExtensionTimelineClipUpdate {
  /** Per-clip audio mute; the audio renderer bypasses a muted clip. */
  readonly isMuted?: boolean;
}

/** Host track classes. A track's class fixes what media it accepts. */
export type ExtensionTimelineTrackType = "visual" | "audio";

export interface ExtensionTimelineTrackCreateInput {
  readonly label?: string;
  /** Omit to leave the track untyped until its first clip fixes the class. */
  readonly type?: ExtensionTimelineTrackType;
  /** Insertion position in track order; clamped. Appends when omitted. */
  readonly index?: number;
}

/** Track properties an extension may set. Omitted fields are left alone. */
export interface ExtensionTimelineTrackUpdate {
  readonly label?: string;
  readonly isVisible?: boolean;
  readonly isMuted?: boolean;
  readonly isLocked?: boolean;
}

export interface ExtensionTimelineCoalescingOptions {
  /** Fresh extension-local key for one interaction, such as one brush stroke. */
  readonly key: string;
  /** `end` closes the interaction after this transaction is committed. */
  readonly phase: "continue" | "end";
}

export interface ExtensionTimelineTransactionOptions {
  /**
   * Merge consecutive commits from one interaction into a bounded undo entry.
   * End every interaction explicitly; unrelated intervening edits split it.
   */
  readonly coalesce?: ExtensionTimelineCoalescingOptions;
}

/**
 * Commands stage *intent*; the host decides the outcome. Every structural rule
 * that keeps a project coherent — overlap resolution, trim limits, track-class
 * compatibility, mask and transition cascades — is enforced inside the host's
 * own mutation layer, using the same code paths a user's drag goes through. An
 * extension therefore cannot author an invalid timeline, and cannot opt out.
 *
 * Two consequences worth designing around:
 *
 * - A request may be **adjusted**. A placement that clips the head or tail of a
 *   neighbour snaps to that neighbour's edge, and a trim is clamped to the
 *   media's own bounds — exactly what dragging there would do. Re-read
 *   `listClips()` after the commit rather than assuming the requested value.
 * - A request may be **refused**. Where the host has no sensible correction it
 *   fails the whole transaction with a specific
 *   {@link ExtensionTimelineTransactionFailureCode} and commits nothing. Note
 *   that landing a clip *on top of* another is refused rather than adjusted
 *   (`no_free_slot`): the host blocks that for a user drag too, because any
 *   "correction" would be a guess about which side you meant.
 */
export interface ExtensionTimelineTransaction {
  /** Returns the host-generated entity ID used by later commands in this transaction. */
  createEntity(input: ExtensionTimelineEntityCreateInput): string;
  updatePayload(entityId: string, payload: ExtensionPayload): void;
  moveEntity(
    entityId: string,
    placement: { readonly startTicks?: number; readonly trackId?: string },
  ): void;
  removeEntity(entityId: string): void;
  /**
   * Places an ordinary clip from a project asset and returns its host-generated
   * ID for later commands in this transaction. The host builds the clip and
   * decides the final position; see `ExtensionTimelineClipCreateInput`.
   */
  createClip(input: ExtensionTimelineClipCreateInput): string;
  /**
   * Slides a clip without changing which part of the source plays. A start that
   * clips a neighbour snaps to that neighbour's edge; one that lands on top of
   * a clip fails with `no_free_slot`. Extension entities keep their owner
   * check — use `moveEntity` for those.
   */
  moveClip(clipId: string, placement: ExtensionTimelineClipPlacement): void;
  /**
   * Retimes a clip's edges, clamped by the host to the media bounds, the
   * neighbouring clips, and the minimum clip duration.
   */
  trimClip(clipId: string, trim: ExtensionTimelineClipTrim): void;
  /**
   * Sets clip properties that carry no structural consequences. Declarative,
   * not a toggle: state the value you want rather than reading first.
   */
  updateClip(clipId: string, update: ExtensionTimelineClipUpdate): void;
  /**
   * Cuts a clip in two at a timeline tick strictly inside it. The right-hand
   * clip is host-generated; read it back with `listClips()` after the commit.
   */
  splitClip(clipId: string, atTicks: number): void;
  /**
   * Removes an ordinary clip and its attached masks. Extension entities keep
   * their owner check — use `removeEntity` for those.
   */
  removeClip(clipId: string): void;
  /** Adds a track and returns its host-generated ID. */
  createTrack(input?: ExtensionTimelineTrackCreateInput): string;
  updateTrack(trackId: string, update: ExtensionTimelineTrackUpdate): void;
  /** Removes a track. The track must hold no clips. */
  removeTrack(trackId: string): void;
  /** Adds or replaces a transform by ID and returns its stable ID. */
  upsertTransform(
    clipId: string,
    transform: ExtensionTimelineTransformInput,
  ): string;
  removeTransform(clipId: string, transformId: string): void;
  /** Creates a first-class transition using one of this extension's transition contributions. */
  createTransition(input: ExtensionTimelineTransitionCreateInput): string;
  updateTransitionParameters(
    transitionId: string,
    parameters: Readonly<Record<string, JsonValue>>,
  ): void;
  removeTransition(transitionId: string): void;
  /** Returns the host-generated mask-local ID used by later mask commands. */
  addClipMask(clipId: string, input: ExtensionTimelineMaskCreateInput): string;
  updateMaskParameters(
    clipId: string,
    maskId: string,
    parameters: Readonly<Record<string, JsonValue>>,
  ): void;
  setMaskActiveRange(
    clipId: string,
    maskId: string,
    range: ExtensionTimelineMaskActiveRange | null,
  ): void;
  removeMask(clipId: string, maskId: string): void;
}

export type ExtensionTimelineTransactionFailureCode =
  | "invalid_label"
  | "invalid_command"
  | "entity_not_found"
  | "clip_not_found"
  | "transition_not_found"
  | "transition_type_not_found"
  | "transform_not_found"
  | "mask_not_found"
  | "mask_type_not_supported"
  | "asset_not_found"
  | "track_not_found"
  /** The destination track's class does not accept this clip's media. */
  | "track_type_mismatch"
  /** A track must be empty before it can be removed. */
  | "track_not_empty"
  /** The clip has no legal position or size on its track. */
  | "no_free_slot"
  | "wrong_owner"
  | "incompatible_payload"
  | "callback_failed";

export type ExtensionTimelineTransactionResult =
  | { readonly ok: true; readonly changed: boolean; readonly label: string }
  | {
      readonly ok: false;
      readonly code: ExtensionTimelineTransactionFailureCode;
      readonly message: string;
      readonly label: string;
    };

export type ExtensionClipOverlayVisibility = "always" | "selected";
export type ExtensionClipOverlayLane = "top" | "middle" | "bottom";
export type ExtensionClipOverlayEdge = "start" | "end";

/** Anchored to a clip edge; multiple items in the same edge/lane stack. */
export interface ExtensionEndpointOverlayPlacement {
  readonly kind: "endpoint";
  readonly edge: ExtensionClipOverlayEdge;
  readonly lane: ExtensionClipOverlayLane;
  readonly insetPx: number;
  readonly order: number;
}

/** Anchored to a source-time position, tracked through crop/speed. */
export interface ExtensionSourceTimeOverlayPlacement {
  readonly kind: "sourceTime";
  readonly sourceTimeTicks: number;
  readonly lane: ExtensionClipOverlayLane;
  readonly offsetPx: number;
  readonly verticalOffsetPx: number;
}

export type ExtensionClipOverlayPlacement =
  | ExtensionEndpointOverlayPlacement
  | ExtensionSourceTimeOverlayPlacement;

export interface ExtensionClipOverlayRenderContext {
  readonly clip: ExtensionTimelineClipSnapshot;
  readonly isSelected: boolean;
  readonly item: ExtensionClipOverlayItem;
}

/** Pointer-drag context with the host's source/visual/presentation tick maths. */
export interface ExtensionClipOverlayDragContext
  extends ExtensionClipOverlayRenderContext {
  readonly event: PointerEvent;
  /** The overlay item's root element; use for direct effects during drag. */
  readonly targetElement: HTMLElement;
  readonly clipLocalX: number;
  readonly presentationOffsetTicks: number;
  readonly visualTimeTicks: number;
  readonly sourceTimeTicks: number;
  readonly deltaClipX: number;
  readonly deltaPresentationOffsetTicks: number;
  readonly deltaVisualTimeTicks: number;
  readonly deltaSourceTimeTicks: number;
  readonly mapPresentationOffsetToClipOffset: (offsetTicks: number) => number;
  readonly mapClipOffsetToPresentationOffset: (offsetTicks: number) => number;
}

export interface ExtensionClipOverlayItemDrag {
  readonly onDragStart?: (context: ExtensionClipOverlayDragContext) => void;
  readonly onDrag?: (context: ExtensionClipOverlayDragContext) => void;
  readonly onDragEnd?: (context: ExtensionClipOverlayDragContext) => void;
}

export interface ExtensionClipOverlayItem {
  readonly id: string;
  /** Trusted React node rendered inside the host-positioned overlay cell. */
  readonly content: unknown;
  readonly visibility?: ExtensionClipOverlayVisibility;
  readonly placement: ExtensionClipOverlayPlacement;
  readonly minClipWidthPx?: number;
  readonly onClick?: () => void;
  readonly onContextMenu?: (event: unknown) => void;
  readonly drag?: ExtensionClipOverlayItemDrag;
}

export interface ExtensionClipOverlaySourceProps {
  readonly clip: ExtensionTimelineClipSnapshot;
  readonly isSelected: boolean;
}

/**
 * A per-clip timeline overlay. `useItems` is a React hook run on every clip
 * render (obey the Rules of Hooks and keep it cheap — it is on the timeline's
 * hot path). Items are positioned, error-isolated, and disposed by the host.
 */
export interface ExtensionClipOverlayDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly kind: "trusted-overlay";
  readonly useItems: (
    props: ExtensionClipOverlaySourceProps,
  ) => readonly ExtensionClipOverlayItem[];
}

export interface ExtensionClipOverlayRegistration extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionTimelineApi {
  /** Canonical project time base used by all timeline command tick fields. */
  readonly ticksPerSecond: number;
  /**
   * Returns a detached snapshot for commands and UI events. This clones every
   * payload and is not intended as a render-loop or polling accessor.
   */
  listEntities(): readonly ExtensionTimelineEntitySnapshot[];
  /** Detached snapshots for user-driven commands; not a render-loop accessor. */
  listClips(): readonly ExtensionTimelineClipSnapshot[];
  /**
   * Detached track snapshots in the project's visual order. Resolves the
   * `trackId` carried by clips, entities, and placement commands.
   */
  listTracks(): readonly ExtensionTimelineTrackSnapshot[];
  /** Detached transition snapshots for user-driven commands. */
  listTransitions(): readonly ExtensionTimelineTransitionSnapshot[];
  /** Detached mask snapshots attached to a clip. */
  listClipMasks(clipId: string): readonly ExtensionTimelineMaskSnapshot[];
  /**
   * Current render-domain dimensions and timebase, detached from host state.
   * Changes to these values signal through `subscribe`/`getRevision`, so a
   * cached copy can be refreshed rather than re-read every frame.
   */
  getProject(): ExtensionTimelineProjectSnapshot;
  /** Converts a zero-based source frame index into vlo's canonical tick unit. */
  sourceFrameToTicks(frameIndex: number, sourceFps: number): number;
  /** Maps normalized clip-local visual progress through crop/speed into source time. */
  clipProgressToSourceTicks(clipId: string, progress: number): number;
  /** Inverse crop/speed mapping used to place source-owned results visually. */
  sourceTicksToClipProgress(clipId: string, sourceTimeTicks: number): number;
  /**
   * Maps source-pixel coordinates through the project's centred contain/cover
   * layout into the additive, centre-origin position-transform domain.
   */
  sourcePointToProject(
    point: ExtensionPoint2D,
    source: ExtensionSourceDimensions,
    fitMode?: "contain" | "cover",
  ): ExtensionPoint2D;
  transaction(
    label: string,
    callback: (transaction: ExtensionTimelineTransaction) => void,
    options?: ExtensionTimelineTransactionOptions,
  ): ExtensionTimelineTransactionResult;
  /**
   * Registers a per-clip timeline overlay. The registration is owner-scoped and
   * removed on disposal/deactivation.
   */
  registerClipOverlay(
    definition: ExtensionClipOverlayDefinition,
  ): ExtensionClipOverlayRegistration;
  /**
   * Fires after any committed timeline model change (undo/redo included) and
   * after any change to the values `getProject()` reports. Commit-grained and
   * payload-free: selection or in-progress interaction state does not signal
   * (use `api.selection` for that); pull detached snapshots on demand.
   * Per-frame and time-driven work belongs in the render contracts, not here.
   */
  subscribe(listener: () => void): () => void;
  /** Monotonic change token matching `subscribe` notifications. */
  getRevision(): number;
}

// === Playback ===

export type ExtensionTransportFailureCode =
  /** No player is mounted — the projects page, or an editor still booting. */
  | "no_transport"
  /**
   * Another flow owns the transport: an export or extraction is running, or a
   * frame/range capture is armed and waiting on the user.
   *
   * This is deliberately stricter than what the host allows the *user* to do —
   * the play button and the ruler stay live during a capture, because someone
   * who armed the mode can see it and decide to move anyway. An extension
   * acting in the background cannot, and moving the playhead under an armed
   * capture would silently change what gets captured.
   */
  | "transport_busy";

/** The editor's answer to a transport write. */
export type ExtensionTransportResult =
  | { readonly ok: true; readonly changed: boolean }
  | {
      readonly ok: false;
      readonly code: ExtensionTransportFailureCode;
      readonly message: string;
    };

/**
 * The transport. Reads are free; writes are requests the player may refuse,
 * because the host — not the extension — arbitrates frame snapping, the audio
 * clock, and export runs. Writes route through the same player entry points a
 * user's click uses, so an extension cannot reach a transport state the UI
 * cannot.
 */
export interface ExtensionPlaybackApi {
  /**
   * The playhead, in the canonical tick unit (`timeline.ticksPerSecond`).
   * Continuous while scrubbing — it is not snapped to a frame boundary.
   */
  getTime(): number;
  /**
   * The tick the renderer is currently presenting — what a frame-accurate
   * reader wants. During playback the displayed frame is snapped to the frame
   * grid while the playhead runs continuously, so this trails `getTime()`;
   * while paused the two agree, because a paused frame is drawn at the
   * playhead itself.
   */
  getFrameTime(): number;
  isPlaying(): boolean;
  /**
   * Moves the playhead. The tick is clamped at zero and snapped to the
   * project's frame grid, as every host seek is, so `getTime()` afterwards may
   * differ from the tick you asked for. Seeking during playback is allowed and
   * resyncs audio, matching a user scrub.
   *
   * Throws for a non-finite tick — that is a bug in the caller, not a state of
   * the editor.
   */
  seek(timeTicks: number): ExtensionTransportResult;
  /** Starts playback from the playhead. Already playing reports `changed: false`. */
  play(): ExtensionTransportResult;
  /**
   * Stops playback. Like the host's own pause, this settles the playhead on a
   * frame boundary, so a pause can move `getTime()`.
   */
  pause(): ExtensionTransportResult;
  /**
   * Fires when the playhead moves or the transport starts/stops. Unlike the
   * other domains this is **not** commit-grained: during playback it fires once
   * per frame. Keep the listener trivial — read `getTime()` and schedule your
   * own work — and prefer the render contracts for anything per-frame.
   */
  subscribe(listener: () => void): () => void;
}

// === Selection ===

/** The host's current editor selection, detached. */
export interface ExtensionSelectionSnapshot {
  /** Selected timeline clip IDs, in host selection order. */
  readonly clipIds: readonly string[];
  /** The selected transition, or null. Clips and transitions are exclusive. */
  readonly transitionId: string | null;
}

export type ExtensionSelectionFailureCode =
  | "clip_not_found"
  /** Mask clips are edited through the mask contracts, never selected. */
  | "clip_not_selectable"
  | "transition_not_found";

/** The editor's answer to a selection write. */
export type ExtensionSelectionResult =
  | { readonly ok: true; readonly changed: boolean }
  | {
      readonly ok: false;
      readonly code: ExtensionSelectionFailureCode;
      readonly message: string;
    };

/**
 * The editor selection. Kept off `api.timeline` because the timeline's signal
 * is deliberately commit-grained: selection changes are not model changes and
 * must not wake timeline subscribers.
 *
 * Writes replace the whole selection rather than adding to it — an extension
 * naming what it wants selected is predictable, while an extension toggling
 * whatever the user had selected is not. Selection is not undoable and does
 * not persist.
 */
export interface ExtensionSelectionApi {
  get(): ExtensionSelectionSnapshot;
  /**
   * Replaces the selection with these clips; an empty array clears it. IDs are
   * deduplicated, order is preserved, and any unknown or unselectable ID
   * refuses the whole request — a selection never partially applies.
   */
  setClips(clipIds: readonly string[]): ExtensionSelectionResult;
  /**
   * Selects one transition, clearing any clip selection; `null` clears the
   * selection entirely.
   */
  setTransition(transitionId: string | null): ExtensionSelectionResult;
  /** Fires after the selection changes. Payload-free; pull with `get()`. */
  subscribe(listener: () => void): () => void;
  /** Monotonic change token matching `subscribe` notifications. */
  getRevision(): number;
}

// === Project ===

/**
 * The open project's identity, detached. Deliberately path-free: an extension
 * addresses project-scoped state through `api.storage.project`, not through
 * the filesystem.
 */
export interface ExtensionProjectSnapshot {
  /** Stable across renames and reopens; the key project storage is scoped by. */
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  /** As recorded in the project manifest when it was loaded. */
  readonly lastModified: number;
  /**
   * When the project document was last written *since this project opened*, or
   * null if it has not been saved yet. Moves on every save, which is what makes
   * a save observable through the shared `subscribe`/`getRevision` pair, and
   * resets when the project closes — reopening the same project starts null
   * again rather than reporting the previous session.
   */
  readonly lastSavedAt: number | null;
}

/**
 * Project identity and lifecycle. `api.timeline.getProject()` is the
 * neighbouring read for the *render* domain — dimensions, fps, fit mode; this
 * one answers "which project, and is one open at all".
 *
 * `subscribe` also covers `api.storage.project` becoming available, so one
 * subscription is enough to watch both. They are not the same condition,
 * though: the storage document hydrates asynchronously, so a project can be
 * open while `storage.project` is still null. Re-read it inside the listener
 * rather than caching what it was when the project opened.
 */
export interface ExtensionProjectApi {
  /** The open project, or null when the editor has none. */
  get(): ExtensionProjectSnapshot | null;
  /**
   * Fires when a project opens or closes, when its identity changes, after
   * every successful save, and when project storage finishes hydrating or is
   * torn down. Payload-free; pull with `get()`.
   */
  subscribe(listener: () => void): () => void;
  /** Monotonic change token matching `subscribe` notifications. */
  getRevision(): number;
  /**
   * Runs before the host writes the project document, which is where an
   * extension flushes in-memory state into `api.storage.project` so the save
   * that follows includes it. It also runs at the head of a project switch,
   * while the outgoing project's storage is still open — that is the last
   * moment unwritten state can be saved.
   *
   * The host awaits the hook, so keep it short: a hook that throws is reported
   * as a diagnostic and skipped, and one that outlives the host's budget is
   * abandoned so a save can never hang on an extension.
   */
  onBeforeSave(hook: ExtensionProjectSaveHook): () => void;
}

export type ExtensionProjectSaveHook = () => void | Promise<void>;

// === Audio ===

/** One placed clip whose source contains audio. */
export interface ExtensionAudioClipSnapshot {
  readonly id: string;
  readonly assetId: string;
  readonly type: "audio" | "video";
  readonly trackId: string;
  readonly startTicks: number;
  readonly durationTicks: number;
  /** Source-media in-point, before timeline retiming. */
  readonly sourceOffsetTicks: number;
  /** Cropped source-media span used by this placement, before retiming. */
  readonly croppedSourceDurationTicks: number;
  readonly isMuted: boolean;
}

/** One track that can currently produce audio. */
export interface ExtensionAudioTrackSnapshot
  extends ExtensionTimelineTrackSnapshot {
  /** Audio-bearing clip IDs on this track, in timeline order. */
  readonly clipIds: readonly string[];
}

/** Decoder metadata for one project asset's primary audio stream. */
export interface ExtensionAudioSourceSnapshot {
  readonly assetId: string;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  /**
   * True stream span (`endTimestampSeconds - firstTimestampSeconds`). This is
   * not the zero-anchored source-tick extent when the first timestamp is nonzero.
   */
  readonly durationSeconds: number;
  /** Timestamp of the first decoded sample; this may be non-zero or negative. */
  readonly firstTimestampSeconds: number;
  /**
   * Exclusive stream end and the asset's zero-anchored source-tick extent in
   * seconds. Use this field when comparing against source ticks.
   */
  readonly endTimestampSeconds: number;
  /** Maximum source frames accepted by one `readPcm()` request. */
  readonly maxPcmFramesPerRead: number;
}

export interface ExtensionAudioReadRequest {
  /** Decoder timestamp. Defaults to the stream's first timestamp. */
  readonly startSeconds?: number;
  /** Decoder timestamp. Defaults to the stream's end timestamp. */
  readonly endSeconds?: number;
  readonly signal?: AbortSignal;
}

export interface ExtensionAudioWaveformRequest extends ExtensionAudioReadRequest {
  /** Source frames summarized by each min/max pair. Defaults to 256. */
  readonly samplesPerPeak?: number;
}

export type ExtensionAudioReadFailureCode =
  | "asset_not_found"
  | "no_audio"
  | "invalid_range"
  | "range_too_large"
  | "decode_failed";

export type ExtensionAudioSourceResult =
  | { readonly ok: true; readonly source: ExtensionAudioSourceSnapshot }
  | {
      readonly ok: false;
      readonly code: ExtensionAudioReadFailureCode;
      readonly message: string;
    };

/**
 * Freshly allocated planar PCM copies. Every channel array is independently
 * owned by the caller and is never retained or reused by the host.
 */
export type ExtensionAudioPcmResult =
  | {
      readonly ok: true;
      readonly source: ExtensionAudioSourceSnapshot;
      readonly startSeconds: number;
      readonly durationSeconds: number;
      readonly channels: readonly Float32Array[];
    }
  | {
      readonly ok: false;
      readonly code: ExtensionAudioReadFailureCode;
      readonly message: string;
    };

export interface ExtensionAudioWaveformChannel {
  readonly min: Float32Array;
  readonly max: Float32Array;
}

/** Peak envelope in source order; each index covers `samplesPerPeak` frames. */
export type ExtensionAudioWaveformResult =
  | {
      readonly ok: true;
      readonly source: ExtensionAudioSourceSnapshot;
      readonly startSeconds: number;
      readonly durationSeconds: number;
      readonly samplesPerPeak: number;
      readonly channels: readonly ExtensionAudioWaveformChannel[];
    }
  | {
      readonly ok: false;
      readonly code: ExtensionAudioReadFailureCode;
      readonly message: string;
    };

/**
 * Audio model discovery and raw-source analysis. Analysis addresses assets,
 * not timeline clips: PCM is decoded before clip mute, effects, or retiming are
 * applied. Use `listClips()` to map an asset analysis back to placements.
 */
export interface ExtensionAudioApi {
  listClips(): readonly ExtensionAudioClipSnapshot[];
  getClip(clipId: string): ExtensionAudioClipSnapshot | undefined;
  listTracks(): readonly ExtensionAudioTrackSnapshot[];
  /** Commit-grained; fires when the timeline or asset library changes. */
  subscribe(listener: () => void): () => void;
  getRevision(): number;
  /**
   * Reports a typed failure when valid input cannot be inspected. A malformed
   * asset ID throws, and cancellation rejects with `AbortError`, including
   * cancellation caused by extension deactivation.
   */
  inspect(
    assetId: string,
    request?: { readonly signal?: AbortSignal },
  ): Promise<ExtensionAudioSourceResult>;
  /**
   * Decodes a bounded source range. One call is capped by the host; split long
   * analyses at `source.maxPcmFramesPerRead`, or use `readWaveform` for an
   * overview. Valid requests the host cannot satisfy return a typed failure;
   * malformed IDs/ranges throw, and cancellation rejects with `AbortError`.
   */
  readPcm(
    assetId: string,
    request?: ExtensionAudioReadRequest,
  ): Promise<ExtensionAudioPcmResult>;
  /**
   * Summarizes a bounded source range. Valid host refusals are typed results;
   * malformed IDs/ranges/peak sizes throw, and cancellation rejects with
   * `AbortError`, including cancellation caused by extension deactivation.
   */
  readWaveform(
    assetId: string,
    request?: ExtensionAudioWaveformRequest,
  ): Promise<ExtensionAudioWaveformResult>;
}

// === Export and render ===

export type ExtensionExportRunKind =
  /** The whole timeline, written to a file the user picked. */
  | "project"
  /** A tick range, landing in the asset library as a new asset. */
  | "range";

export type ExtensionExportRunStatus =
  | "running"
  | "completed"
  /** The renderer aborted — the user pressed Cancel, or a caller cancelled. */
  | "cancelled"
  | "failed";

/** One render the editor has performed or is performing, detached. */
export interface ExtensionExportRunSnapshot {
  readonly id: string;
  readonly kind: ExtensionExportRunKind;
  readonly status: ExtensionExportRunStatus;
  /** The rendered range, in the canonical tick unit. */
  readonly startTicks: number;
  readonly endTicks: number;
  /** Option ID from the `export.formats` catalogue, when the run named one. */
  readonly formatId: string | null;
  /** 0 to 1. Held at its last value once the run settles. */
  readonly progress: number;
  readonly startedAt: number;
  /** When it settled, or null while it is still running. */
  readonly endedAt: number | null;
  /**
   * The extension that started it, or null for a run the user started. Compare
   * against your own ID rather than assuming a run is yours.
   */
  readonly startedByExtension: string | null;
  /**
   * The asset the render produced, readable through `api.assets`. Null for a
   * project export, which writes to the user's file rather than the library,
   * and for any run that did not complete.
   */
  readonly assetId: string | null;
  /** Why it failed, for a failed run. */
  readonly error: string | null;
}

export type ExtensionExportFailureCode =
  /** No renderer is mounted — the projects page, or an editor still booting. */
  | "no_renderer"
  /** A render is already in flight. Renders are exclusive and nothing queues. */
  | "export_busy"
  | "no_project"
  /** Non-positive range, or one that falls outside the timeline. */
  | "invalid_range"
  /** No such option in the `export.formats` catalogue. */
  | "unknown_format"
  /** The renderer produced no frame. `message` carries what it reported. */
  | "render_failed";

export interface ExtensionExportStartRequest {
  /**
   * Option ID from the `export.formats` catalogue — enumerate it through
   * `api.ui.catalogues`. The host default is used when omitted.
   */
  readonly formatId?: string;
  /** Defaults to the whole timeline. */
  readonly startTicks?: number;
  readonly endTicks?: number;
  /** Render frame rate. The project's own rate when omitted. */
  readonly fps?: number;
  /** Renders every Nth frame; 1 renders them all. */
  readonly frameStep?: number;
  /** Restricts the render to these tracks. All tracks when omitted. */
  readonly trackIds?: readonly string[];
}

/**
 * The editor's answer to a start request — whether a run *began*, not how it
 * ended. A render takes minutes; watch the run through `subscribe`.
 */
export type ExtensionExportStartResult =
  | { readonly ok: true; readonly run: ExtensionExportRunSnapshot }
  | {
      readonly ok: false;
      readonly code: ExtensionExportFailureCode;
      readonly message: string;
    };

export interface ExtensionExportFrameRequest {
  readonly mimeType?: "image/png" | "image/webp";
  /** Encoder quality, 0 to 1, where the format honours it. */
  readonly quality?: number;
}

export type ExtensionExportFrameResult =
  | {
      readonly ok: true;
      /**
       * The frame as an **encoded** image, in the requested `mimeType` — not
       * raw pixels. To measure the picture, decode it first, e.g. with
       * `createImageBitmap` onto a 2D canvas; note that `getImageData` returns
       * straight alpha, while the renderer composites premultiplied.
       */
      readonly blob: Blob;
      /** The project's output dimensions, rounded to even pixels. */
      readonly width: number;
      readonly height: number;
      /** The tick that was rendered, after frame snapping. */
      readonly timeTicks: number;
    }
  | {
      readonly ok: false;
      readonly code: ExtensionExportFailureCode;
      readonly message: string;
    };

/**
 * Rendering: observing the editor's renders, reading single composited frames,
 * and asking for a render of your own.
 *
 * Renders are **exclusive** — one GPU context and one decoder pool — so this
 * domain has no queue. A request made while the renderer is busy is refused
 * with `export_busy` rather than deferred, and a run therefore never sits in a
 * pending state you have to wait through.
 *
 * `renderFrame` is a request and answers with a promise; `start` begins a run
 * and answers immediately with the run itself. That difference is deliberate:
 * a frame is a value, while a render is a long-lived thing the user can cancel
 * and other observers can watch, so its outcome arrives through the same
 * `subscribe`/`getRevision` pair every other domain uses.
 */
export interface ExtensionExportApi {
  /** The run in flight, or the most recent one to finish. Null before any. */
  getRun(): ExtensionExportRunSnapshot | null;
  /**
   * This session's runs, newest first and capped — the log is for reporting on
   * a session, not an audit trail. Persist anything you need to keep.
   */
  listRuns(): readonly ExtensionExportRunSnapshot[];
  /**
   * Fires when a run starts, reports progress, or settles, and again when the
   * renderer becomes free — the editor can still be busy for a moment after a
   * run settles, so a `start()` from inside a completion notification may be
   * refused with `export_busy`. Wait for the next notification rather than
   * treating the refusal as final. Progress-grained: during a render this
   * fires repeatedly. Payload-free; pull with `getRun()`.
   */
  subscribe(listener: () => void): () => void;
  /** Monotonic change token matching `subscribe` notifications. */
  getRevision(): number;
  /**
   * Composites one frame at `timeTicks` and returns it as an encoded image at
   * the project's output dimensions. This is a full render of that instant —
   * every track, mask, and effect — so it costs roughly what one export frame
   * costs; it is for thumbnails and spot checks, not for scrubbing.
   *
   * The tick is clamped at zero and snapped to the project's frame grid, as
   * every host seek is, and the result reports which tick was composited. It
   * is *not* clamped to the timeline's end: a tick past the last clip renders
   * the empty frame that is genuinely there, exactly as parking the playhead
   * beyond the content does. Derive the end from `timeline.listClips()` if you
   * need to stay inside it.
   *
   * Refused with `export_busy` while a run — or another frame render — is in
   * flight, because compositing owns the decoders. Throws for a non-finite
   * tick, which is a bug in the caller rather than a state of the editor.
   */
  renderFrame(
    timeTicks: number,
    request?: ExtensionExportFrameRequest,
  ): Promise<ExtensionExportFrameResult>;
  /**
   * Renders a range into a new library asset, reported on the run as
   * `assetId`. The user sees the host's own progress dialog and can cancel it,
   * because a background render that holds the editor for minutes with nothing
   * on screen is indistinguishable from a hang.
   *
   * Throws for a malformed request; refuses with a code when the editor cannot
   * take it.
   */
  start(request?: ExtensionExportStartRequest): ExtensionExportStartResult;
  /**
   * Cancels a run you started. The renderer aborts asynchronously, so
   * `changed: true` means a cancel was issued against a live run, not that it
   * has already settled — watch `subscribe` for that. `changed: false` means
   * the run had settled before you asked. Runs started by the user or another
   * extension are refused; the host's dialog is where those get cancelled.
   */
  cancel(runId: string): ExtensionExportCancelResult;
}

export type ExtensionExportCancelFailureCode =
  | "run_not_found"
  /** The run belongs to the user or another extension. */
  | "run_not_owned"
  | "no_renderer";

export type ExtensionExportCancelResult =
  | { readonly ok: true; readonly changed: boolean }
  | {
      readonly ok: false;
      readonly code: ExtensionExportCancelFailureCode;
      readonly message: string;
    };

/** Restricted-ready convenience filters executed entirely by the host. */
export type ExtensionDeclarativeHostFilter =
  | "color-adjustment"
  | "hsl-adjustment"
  | "bloom"
  | "glow"
  | "crt"
  | "old-film"
  | "dot"
  | "ascii"
  | "bulge-pinch";

/** @deprecated Prefer the explicit `ExtensionDeclarativeHostFilter` name. */
export type ExtensionHostFilter = ExtensionDeclarativeHostFilter;

export interface ExtensionTransformationNumberControl {
  readonly type: "slider" | "number";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly supportsSpline?: boolean;
}

export interface ExtensionTransformationCheckboxControl {
  readonly type: "checkbox";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: boolean;
}

export interface ExtensionTransformationTextControl {
  readonly type: "text" | "color";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string;
}

export interface ExtensionTransformationSelectOption {
  readonly label: string;
  readonly value: string | number;
}

export interface ExtensionTransformationSelectControl {
  readonly type: "select";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string | number;
  readonly options: readonly ExtensionTransformationSelectOption[];
}

/**
 * Mounts a rich control registered with `ui.registerPanelControl()` inside this
 * transformation's own group. UI-only: `name` identifies the control, it is not
 * a persisted parameter, and it never appears in `defaultParameters`.
 */
export interface ExtensionTransformationCustomControl {
  readonly type: "custom";
  readonly name: string;
  readonly label: string;
  /** A panel-control ID registered by the same extension. Not owner-qualified. */
  readonly componentId: string;
  readonly config?: Readonly<Record<string, JsonValue>>;
  /**
   * Restricts what the control may commit. Omit to allow every parameter this
   * transformation declares.
   */
  readonly parameterNames?: readonly string[];
}

export type ExtensionTransformationControl =
  | ExtensionTransformationNumberControl
  | ExtensionTransformationCheckboxControl
  | ExtensionTransformationTextControl
  | ExtensionTransformationSelectControl
  | ExtensionTransformationCustomControl;

export interface ExtensionTransformationControlGroup {
  readonly id: string;
  readonly title: string;
  readonly columns?: number;
  readonly controls: readonly ExtensionTransformationControl[];
}

interface ExtensionTransformationBaseDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly label: string;
  readonly adjustmentCompatible?: boolean;
  readonly groups: readonly ExtensionTransformationControlGroup[];
}

/**
 * Declarative, restricted-ready transformation backed by a host-owned filter.
 * This is a convenience lane, not the authority ceiling for trusted extensions.
 */
export interface ExtensionHostFilterTransformationDefinition
  extends ExtensionTransformationBaseDefinition {
  readonly kind: "host-filter";
  readonly hostFilter: ExtensionDeclarativeHostFilter;
}

/**
 * Extension-facing projection of the host's native filter time dependency.
 *
 * - `none`: the output is a pure function of its parameters and the current
 *   input texture. Stateless filters (e.g. desaturate) omit rendering metadata
 *   and default to this.
 * - `sample`: the output reads the current timeline sample (procedural filters
 *   that animate from canonical visual time) but keep no previous-frame state.
 * - `history`: the output depends on earlier samples through retained feedback
 *   state (e.g. Matrix Rain). The host may replay bounded warm-up frames.
 */
export type ExtensionFilterTimeDependency = "none" | "sample" | "history";

/**
 * Optional authoring/runtime policy describing how a trusted filter consumes
 * time. It is not persisted per transform; it is definition metadata the host
 * uses to schedule replay and to key sample-aware caches.
 */
export interface ExtensionTrustedFilterRenderingDefinition {
  readonly timeDependency: ExtensionFilterTimeDependency;
  /** Maximum earlier presentation time the host may need to replay. */
  readonly maxHistorySeconds?: number;
  /** Largest continuous step the effect accepts without replay/subdivision. */
  readonly maxStepSeconds?: number;
}

export type ExtensionRenderMode = "preview" | "export" | "still";

export type ExtensionRenderContinuity =
  | "initial"
  | "sequential"
  | "repeat"
  | "discontinuous";

/**
 * Immutable extension projection of the host's native render-sample identity
 * and timing. It lets a temporal filter distinguish sequential frames,
 * repeated paused renders, seeks, stills, and exports without reading any
 * global clock.
 */
export interface ExtensionFilterRenderSample {
  /** Changes whenever the host invalidates temporal history. */
  readonly sequenceId: number;
  /** Stable across duplicate GPU submissions for one logical sample. */
  readonly sampleId: number;
  readonly mode: ExtensionRenderMode;
  readonly continuity: ExtensionRenderContinuity;
  readonly presentationTimeTicks: number;
  readonly visualTimeTicks: number;
  readonly sourceTimeTicks: number;
  /** Present only when the host certifies continuity from the previous sample. */
  readonly deltaTimeTicks: number | null;
  readonly fps: number;
  /** Warm-up frames update state but are not presented or encoded. */
  readonly isWarmup: boolean;
}

export interface ExtensionTrustedFilterApplyContext {
  /** The actual host Pixi target. Trusted extensions may narrow this object. */
  readonly target: object;
  /** The authored transform ID this filter instance is bound to. */
  readonly transformId: string;
  readonly contentSize?: Readonly<{ width: number; height: number }>;
  readonly render: ExtensionFilterRenderSample;
}

/**
 * One extension-created object from the injected host Pixi runtime. Domain
 * adapters validate its concrete type and own attachment, detachment, and final
 * Pixi destruction; extensions update it and release only their extra resources.
 */
export interface ExtensionTrustedPixiObjectInstance<
  TParameters = Readonly<Record<string, unknown>>,
  TContext = unknown,
> {
  readonly object: object;
  update(parameters: TParameters, context: TContext): void;
  /** Release resources other than `object`; the host destroys the Pixi object. */
  destroy?(): void;
}

export type ExtensionTrustedFilterInstance =
  ExtensionTrustedPixiObjectInstance<
    Readonly<Record<string, unknown>>,
    ExtensionTrustedFilterApplyContext
  >;

/**
 * Primary trusted filter contract. `createFilter` may construct arbitrary Pixi
 * filters, including custom GLSL/WGSL programs, using `api.runtime.pixi`.
 */
export interface ExtensionTrustedFilterTransformationDefinition
  extends ExtensionTransformationBaseDefinition {
  readonly kind: "trusted-filter";
  readonly defaultParameters?: Readonly<Record<string, JsonValue>>;
  readonly validateParameters?: (
    parameters: Readonly<Record<string, unknown>>,
  ) => boolean;
  /**
   * Optional render-dependency policy. Omitting it means
   * `timeDependency: "none"`, preserving existing stateless extensions.
   */
  readonly rendering?: ExtensionTrustedFilterRenderingDefinition;
  readonly createFilter: () => ExtensionTrustedFilterInstance;
}

export interface ExtensionTrustedTransformationState {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  filters: Array<{
    type: string;
    params: Record<string, unknown>;
  }>;
  blendMode?: string;
}

export interface ExtensionTrustedTransformationApplyContext {
  readonly state: ExtensionTrustedTransformationState;
  readonly transform: Readonly<{
    id: string;
    type: string;
    isEnabled: boolean;
    parameters: Readonly<Record<string, unknown>>;
  }>;
  readonly render: Readonly<{
    container: Readonly<{ width: number; height: number }>;
    content: Readonly<{ width: number; height: number }>;
    time?: number;
    visualTime?: number;
    visualDuration?: number;
  }>;
}

/** Primary trusted contract for arbitrary render-state transformations. */
export interface ExtensionTrustedTransformationDefinition
  extends ExtensionTransformationBaseDefinition {
  readonly kind: "trusted-transformation";
  readonly defaultParameters?: Readonly<Record<string, JsonValue>>;
  readonly validateParameters?: (
    parameters: Readonly<Record<string, unknown>>,
  ) => boolean;
  readonly apply: (context: ExtensionTrustedTransformationApplyContext) => void;
}

/** Timing and parameter-resolution seam for one scheduled audio chunk. */
export interface ExtensionTrustedAudioEffectApplyContext {
  readonly audioContext: BaseAudioContext;
  readonly startContextTime: number;
  readonly wallDurationSeconds: number;
  readonly startPresentationTimeTicks: number;
  readonly durationTicks: number;
  readonly sampleCount: number;
  /** Maps presentation time through clip crop/retiming into source time. */
  sourceTimeTicksAt(presentationTimeTicks: number): number;
  /**
   * Resolves one authored parameter at a presentation tick. Numeric controls
   * that support splines are sampled in source-media time; other JSON values
   * are returned detached and unchanged.
   */
  resolveParameter(
    name: string,
    presentationTimeTicks: number,
  ): JsonValue | undefined;
}

/** One context-bound Web Audio effect occurrence owned by the host chain. */
export interface ExtensionTrustedAudioEffectInstance {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  /**
   * `parameters` is a detached snapshot of the raw authored values and must be
   * narrowed by the extension. Prefer `context.resolveParameter()` for values
   * described by controls, especially animated numeric parameters.
   */
  apply(
    parameters: Readonly<Record<string, unknown>>,
    context: ExtensionTrustedAudioEffectApplyContext,
  ): void;
  /** Releases internal resources; the host disconnects the two endpoints. */
  destroy?(): void;
}

/** Trusted Web Audio contribution, authored and placed like any other effect. */
export interface ExtensionTrustedAudioEffectTransformationDefinition
  extends ExtensionTransformationBaseDefinition {
  readonly kind: "trusted-audio-effect";
  /** Audio effects do not apply to visual adjustment groups. */
  readonly adjustmentCompatible?: false;
  readonly defaultParameters?: Readonly<Record<string, JsonValue>>;
  readonly validateParameters?: (
    parameters: Readonly<Record<string, unknown>>,
  ) => boolean;
  /** Conservative lifecycle/export preroll bound, from 0 through 60 seconds. */
  readonly maxTailSeconds?: number;
  readonly createEffect: (
    audioContext: BaseAudioContext,
  ) => ExtensionTrustedAudioEffectInstance;
}

export type ExtensionTransformationDefinition =
  | ExtensionTrustedFilterTransformationDefinition
  | ExtensionTrustedTransformationDefinition
  | ExtensionTrustedAudioEffectTransformationDefinition
  | ExtensionHostFilterTransformationDefinition;

export interface ExtensionTransformationRegistration
  extends ExtensionDisposable {
  readonly id: string;
}

// === Parameter presets ===

/**
 * The transformation a preset patches. The registry is generic, but each target
 * is host-adapted: it needs a declared identity, a parameter validator, merge
 * semantics, and host UI that consumes the registry. `ColorGradeFilter` is the
 * first supported target.
 */
export interface ExtensionParameterPresetTarget {
  readonly kind: "filter";
  readonly filterName: string;
}

export interface ExtensionParameterPresetDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly label: string;
  readonly target: ExtensionParameterPresetTarget;
  /**
   * A partial, static parameter patch, validated and clamped by the target's
   * host schema. Omitted fields keep their authored values, so a preset never
   * resets parameters it does not mention.
   *
   * API version 1 rejects animated values, because transferring them correctly
   * needs a source time range the preset cannot carry, and `lutAssetId`, because
   * an extension package cannot know a durable project asset ID.
   */
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly order?: number;
}

export interface ExtensionParameterPresetRegistration
  extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionParameterPresetApi {
  register(
    definition: ExtensionParameterPresetDefinition,
  ): ExtensionParameterPresetRegistration;
}

export interface ExtensionTransformationApi {
  register(
    definition: ExtensionTransformationDefinition,
  ): ExtensionTransformationRegistration;
  /** Static parameter patches offered by host panels that support a target. */
  readonly presets: ExtensionParameterPresetApi;
}

export interface ExtensionTransitionNumberControl {
  readonly type: "slider" | "number";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
}

export interface ExtensionTransitionCheckboxControl {
  readonly type: "checkbox";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: boolean;
}

export interface ExtensionTransitionTextControl {
  readonly type: "text" | "color";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string;
}

export interface ExtensionTransitionSelectOption {
  readonly label: string;
  readonly value: string | number | boolean;
}

export interface ExtensionTransitionSelectControl {
  readonly type: "select";
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string | number | boolean;
  readonly options: readonly ExtensionTransitionSelectOption[];
}

export type ExtensionTransitionControl =
  | ExtensionTransitionNumberControl
  | ExtensionTransitionCheckboxControl
  | ExtensionTransitionTextControl
  | ExtensionTransitionSelectControl;

export interface ExtensionTransitionControlGroup {
  readonly id: string;
  readonly title: string;
  readonly columns?: number;
  readonly controls: readonly ExtensionTransitionControl[];
}

export type ExtensionTransitionZOrder =
  | "default"
  | "outgoing-on-top"
  | "incoming-on-top";

export interface ExtensionTransitionTransform {
  readonly id?: string;
  readonly type: string;
  readonly isEnabled?: boolean;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly templateId?: string;
  readonly filterName?: string;
}

export interface ExtensionTransitionColorLayer {
  readonly id?: string;
  readonly color: string;
  readonly zIndexOffset?: number;
}

export interface ExtensionTransitionRenderInput {
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly schemaVersion: number;
  readonly progress: number;
  readonly transition: Readonly<{
    readonly id: string;
    readonly startTicks: number;
    readonly endTicks: number;
    readonly durationTicks: number;
  }>;
  readonly outgoingClip: ExtensionTimelineClipSnapshot;
  readonly incomingClip: ExtensionTimelineClipSnapshot;
  readonly frame: Readonly<{
    readonly projectWidth: number;
    readonly projectHeight: number;
    readonly fps: number;
    readonly presentationTimeTicks: number;
  }>;
}

export interface ExtensionTransitionFrame {
  readonly outgoingTransforms?: readonly ExtensionTransitionTransform[];
  readonly incomingTransforms?: readonly ExtensionTransitionTransform[];
  readonly colorLayers?: readonly ExtensionTransitionColorLayer[];
  readonly zOrder?: ExtensionTransitionZOrder;
}

export interface ExtensionTransitionParameterMigration {
  readonly schemaVersion: number;
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

export interface ExtensionTransitionDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly label: string;
  readonly glyph: string;
  readonly schemaVersion: number;
  readonly defaultParameters?: Readonly<Record<string, JsonValue>>;
  readonly groups?: readonly ExtensionTransitionControlGroup[];
  readonly zOrder?: ExtensionTransitionZOrder;
  validateParameters?(
    parameters: Readonly<Record<string, JsonValue>>,
    schemaVersion: number,
  ): boolean;
  migrateParameters?(
    parameters: Readonly<Record<string, JsonValue>>,
    fromSchemaVersion: number,
  ): ExtensionTransitionParameterMigration;
  renderFrame(input: ExtensionTransitionRenderInput): ExtensionTransitionFrame;
}

export interface ExtensionTransitionRegistration extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionTransitionApi {
  register(
    definition: ExtensionTransitionDefinition,
  ): ExtensionTransitionRegistration;
}

export interface ExtensionPixiShaderSource {
  readonly vertex: string;
  readonly fragment: string;
  readonly name?: string;
}

/**
 * Deliberately open Pixi filter options. The common shader fields are typed;
 * trusted extensions may use any other host-version-specific Pixi option.
 */
export interface ExtensionPixiFilterOptions {
  readonly gl?: ExtensionPixiShaderSource;
  readonly gpu?: Readonly<Record<string, unknown>>;
  readonly resources?: Readonly<Record<string, unknown>>;
  readonly padding?: number;
  readonly resolution?: number | "inherit";
  readonly antialias?: boolean | "on" | "off" | "inherit";
  readonly blendRequired?: boolean;
  readonly clipToViewport?: boolean;
  readonly [option: string]: unknown;
}

/**
 * The actual host `pixi.js` module namespace. Frequently used Filter APIs are
 * typed here; authors may narrow other exports with type-only Pixi imports.
 */
export interface ExtensionPixiRuntime {
  readonly Filter: {
    new (options: ExtensionPixiFilterOptions): object;
    from(options: ExtensionPixiFilterOptions): object;
  };
  readonly [exportName: string]: unknown;
}

export interface ExtensionReactRuntime {
  createElement(
    type: unknown,
    props: Readonly<Record<string, unknown>> | null,
    ...children: unknown[]
  ): unknown;
  readonly [exportName: string]: unknown;
}

/** Host-curated MUI controls without a duplicate emotion/theme tree. */
export interface ExtensionMuiRuntime {
  readonly [exportName: string]: unknown;
}

/**
 * Complete, version-coupled host panelUI barrel for trusted extensions.
 * Prefer scoped contribution APIs where available; this runtime remains the
 * unscoped authority escape hatch and is not restricted-mode compatible.
 */
export interface ExtensionPanelUiRuntime {
  readonly [exportName: string]: unknown;
}

/**
 * One staged edit, as an editing surface performs it.
 *
 * These describe *gestures*, not writes. The draft derives what to commit by
 * diffing its projection against the panel, so what you see staged is what
 * lands — an attach you then clear simply is not in the target.
 *
 * `attachAsset` appends (a single-slot input replaces what it holds);
 * `replaceMedia` overwrites the filled position `at`. There is deliberately no
 * positioned insert: nothing in the panel inserts between tiles, and one op
 * meaning both is how a drop meant to overwrite ended up pushing the tile
 * along instead.
 */
export type ExtensionGenerationDraftOp =
  | { readonly kind: "setText"; readonly inputId: string; readonly value: string }
  | {
      /**
       * Hold a text input you will write yourself in `commit`'s
       * `additionalWrites`, without staging a value. Since SDK 1.26.0.
       *
       * For text that can only be resolved at commit — a prompt that numbers
       * references against the arrangement being committed. Staging this
       * records the panel's text as it stands, so if the user edits that input
       * in the panel afterwards the draft reports a conflict and refuses to
       * commit, instead of your write silently replacing their edit. Stage it
       * when your editing begins, and again after each successful commit.
       */
      readonly kind: "holdText";
      readonly inputId: string;
    }
  | {
      readonly kind: "attachAsset";
      readonly inputId: string;
      readonly assetId: string;
      readonly itemOptions?: Readonly<Record<string, boolean>>;
    }
  | {
      readonly kind: "replaceMedia";
      readonly inputId: string;
      readonly assetId: string;
      /** The filled position to overwrite. */
      readonly at: number;
      readonly itemOptions?: Readonly<Record<string, boolean>>;
    }
  | {
      readonly kind: "removeMedia";
      readonly inputId: string;
      readonly slotId: string;
    }
  | {
      readonly kind: "moveMedia";
      readonly inputId: string;
      readonly fromOrdinal: number;
      readonly toOrdinal: number;
    }
  | {
      readonly kind: "setMediaOption";
      readonly inputId: string;
      readonly slotId: string;
      readonly optionId: string;
      readonly value: boolean;
    }
  | {
      /**
       * A widget, not an input: the panel's `length` slider and its like are
       * node parameters. Staged alongside inputs because a composer deriving
       * text from a duration has to see the duration the user is choosing.
       */
      readonly kind: "setWidget";
      readonly nodeId: string;
      readonly param: string;
      readonly value: JsonValue;
    };

/** What a draft edits. Everything outside it stays the panel's alone. */
export interface ExtensionGenerationInputsDraftRequest {
  readonly inputIds: readonly string[];
  /**
   * Widgets to edit alongside them. A duration a composer derives text from
   * belongs beside that text, not one panel away.
   */
  readonly widgetTargets?: readonly ExtensionGenerationWidgetTarget[];
  /**
   * Text inputs to hold for conflict detection only (SDK 1.26.0). `holdText`
   * may name them and a panel edit to them becomes a conflict, but the draft
   * never lists them in `getState().inputs`, `InputsDraftFields` never renders
   * them, and the draft never writes them. Use this for the prompt you write
   * yourself in `additionalWrites`: addressing it through `inputIds` instead
   * would offer an editable field whose staged text your write then replaces.
   */
  readonly holdInputIds?: readonly string[];
}

/** A draft's current reading, projected exactly as a live session is. */
/**
 * Whether a draft can be edited at all, and if not, why.
 *
 * Check this before reading anything else: `inputs` is empty and `canCommit`
 * is `false` in both non-`ready` states, so a package that skips it draws an
 * empty editor with nothing to say.
 *
 * - `ready` — a generation panel is mounted and this draft is live.
 * - `unavailable` — no panel is open. Transient; a session arriving fixes it.
 * - `disposed` — the draft is finished, because you disposed it or your
 *   activation ended. Terminal, and a bug on your side if you are still
 *   rendering it: open a new draft rather than waiting for this one to recover.
 *   The commonest cause is opening a draft during render (a `useMemo`, a
 *   `useState` initializer) — StrictMode's setup → cleanup → setup then
 *   disposes it and the memo never re-runs. Open it in an effect instead.
 */
export type ExtensionGenerationDraftStatus =
  | "ready"
  | "unavailable"
  | "disposed";

export interface ExtensionGenerationInputsDraftState {
  /** Whether the draft is live, waiting for a panel, or finished. */
  readonly status: ExtensionGenerationDraftStatus;
  readonly inputs: readonly ExtensionGenerationInputSnapshot[];
  /** The addressed widgets, keyed `nodeId:param`, staged values included. */
  readonly widgetValues: ReadonlyMap<string, JsonValue>;
  /** The draft holds edits of its own. */
  readonly hasDraftChanges: boolean;
  /** The panel moved under an input or widget this draft is holding. */
  readonly hasConflict: boolean;
  /**
   * A transaction may be attempted. True with nothing staged, because a caller
   * may still have `additionalWrites` of its own — a composer writing only
   * prompt text has nothing staged here and must not be blocked.
   */
  readonly canCommit: boolean;
  /** Why a commit is refused, or why the last one failed. */
  readonly error: string | null;
}

/**
 * The arrangement one draft commit writes, passed to `additionalWrites`.
 * Since SDK 1.26.0.
 *
 * Resolve anything that depends on the media — reference tag numbers above
 * all — against this rather than against the last `getState` you rendered.
 * It is computed after the conflict check from the session the transaction
 * opens on, so what you number and what is written are one arrangement. If
 * the addressed inputs change while your callback runs, the commit fails
 * `session_changed` and nothing is written.
 *
 * A staged item's `slotId` here is a placeholder, not a write address; refer
 * to items by `itemId`, which a staged item keeps once it is committed.
 */
export interface ExtensionGenerationDraftCommitReading {
  /** The addressed inputs as this commit leaves them. */
  readonly inputs: readonly ExtensionGenerationInputSnapshot[];
  /** The addressed widgets, keyed `nodeId:param`, as this commit leaves them. */
  readonly widgetValues: ReadonlyMap<string, JsonValue>;
  readonly workflow: {
    readonly revision: number;
    readonly fingerprint: string;
    readonly instanceId: string | null;
  };
}

/**
 * A staged editor over some of the generation panel's inputs.
 *
 * Edits are held, not written: the panel is untouched until `commit`. Opened
 * through `api.generation.createInputsDraft`, so it is owned by your activation
 * and refuses to write once that ends — which is why it is not a component.
 * Render it with `runtime.generationUi.InputsDraftFields`, or read `getState`
 * and draw your own.
 */
export interface ExtensionGenerationInputsDraft {
  getState(): ExtensionGenerationInputsDraftState;
  /** Notified whenever the reading changes. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /**
   * Stage one edit. Ignored if it addresses something this draft is not
   * editing; throws on a malformed op rather than failing later at commit.
   */
  stage(op: ExtensionGenerationDraftOp): void;
  revert(): void;
  /**
   * Writes the staged edits and `additionalWrites` in **one** transaction, so
   * a composer's prompt text and its keyframes land together or not at all.
   * The staged edits are cleared only on success.
   */
  commit(
    label: string,
    additionalWrites?: (
      transaction: ExtensionGenerationTransaction,
      reading: ExtensionGenerationDraftCommitReading,
    ) => void,
  ): ExtensionGenerationTransactionResult;
  /** Drop the draft and stop tracking the panel. Also done on deactivation. */
  dispose(): void;
}

export interface ExtensionGenerationDraftFieldsProps {
  /** A draft from `api.generation.createInputsDraft`. */
  readonly controller: ExtensionGenerationInputsDraft;
}

/**
 * Generation-panel UI a package can render, typed rather than an open map.
 *
 * `InputsDraftFields` draws the panel's own input fields over a draft you
 * opened. Only interactions the transaction can express are offered — timeline
 * capture, external file drops and media editing are shown refused, because
 * each starts work that cannot be held until commit.
 *
 * It writes nothing itself: every edit goes through the controller you passed,
 * which is the thing your activation owns.
 */
export interface ExtensionGenerationUiRuntime {
  /**
   * Mount for one timeline capture. Uses the panel's selection UI and holds
   * native captured media in this draft without creating a library asset.
   * Committing writes the capture to the panel input. Unmount cancels pending
   * delivery. A changed/disposed draft cannot receive a late result.
   * Optional for compatibility with hosts predating this renderer.
   */
  readonly InputsDraftCapture?: (props: {
    readonly controller: ExtensionGenerationInputsDraft;
    readonly inputId: string;
    readonly at: number;
    readonly onDone: (error: string | null) => void;
  }) => unknown;
  readonly InputsDraftFields: (
    props: ExtensionGenerationDraftFieldsProps,
  ) => unknown;
}

/** Exact host singleton runtimes supplied to trusted frontend extensions. */
export interface ExtensionHostRuntimeApi {
  readonly pixi: ExtensionPixiRuntime;
  readonly react: ExtensionReactRuntime;
  readonly mui: ExtensionMuiRuntime;
  readonly panelUi: ExtensionPanelUiRuntime;
  /** Typed generation-panel surfaces; see `ExtensionGenerationUiRuntime`. */
  readonly generationUi: ExtensionGenerationUiRuntime;
}

/** One discoverable, version-coupled live host reference. */
export interface ExtensionTrustedHostEntry {
  readonly id: string;
  readonly available: boolean;
  /** Session entries retain identity; availability entries may be replaced. */
  readonly lifetime: "session" | "availability";
}

/**
 * Stable reachability mechanism for trusted extensions. Entry IDs and returned
 * shapes are raw host internals and are not SDK compatibility promises.
 */
export interface ExtensionTrustedHostApi {
  /** VLO application/build version, distinct from the extension SDK version. */
  readonly hostVersion: string | null;
  /** Discovery is isolated: one invalid host entry is reported as unavailable. */
  list(): readonly ExtensionTrustedHostEntry[];
  /** Return the live reference, or undefined when unavailable or shape-invalid. */
  get(id: string): unknown;
  /** Return the live reference or throw an extension-labelled diagnostic error. */
  require(id: string): unknown;
  /** Monotonic change token for availability-scoped entries. */
  getRevision(): number;
  subscribe(listener: () => void): () => void;
  /**
   * Install an owner-tracked descriptor-factory patch. Factories may be run
   * repeatedly and must be synchronous, deterministic, and side-effect free.
   */
  patchProperty(
    target: object,
    property: PropertyKey,
    createDescriptor: (
      previous: PropertyDescriptor | undefined,
    ) => PropertyDescriptor,
  ): ExtensionDisposable;
}

export interface ExtensionTrustedApi {
  readonly host: ExtensionTrustedHostApi;
}

/** Open string type; the host still accepts only slot regions it declares. */
export type ExtensionUiSlotId = string;
export type ExtensionUiNoticeTone = "info" | "success" | "warning";
export type ExtensionUiModalSize = "small" | "medium" | "large";
export type ExtensionUiViewRegion =
  | "right-sidebar"
  | "left-sidebar"
  | "projects-page.main"
  /**
   * A narrow column beside the player canvas, for tools that have to sit next
   * to the picture. It takes no space until something is registered in it.
   */
  | "player-aside"
  /**
   * The dock between the player and the timeline, where the video scopes live.
   * Unlike the sidebars this region is user-toggled and starts closed, so a
   * view registered here is not visible until `openView` — or the user — opens
   * the dock.
   */
  | "bottom-dock"
  /**
   * A draggable, resizable panel floating over the editor, for a workspace
   * that must stay open while the user works in the surface behind it.
   *
   * It starts closed — open it with `openView` — and, unlike a modal, it sits
   * *inside* the editor's drag context, so `runtime.panelUi` drop slots in it
   * accept library drags. A modal cannot: see `registerModal`.
   */
  | "editor-overlay";

/**
 * The regions a view may be *moved* between, which is a strictly smaller set
 * than the regions it may be registered in.
 *
 * Only docked regions can host a moved panel: they are the ones the layout
 * kernel arranges, persists and offers in "Manage panels". `editor-overlay`
 * floats over the editor and `projects-page.main` belongs to a different
 * screen, so neither can take part.
 */
export type ExtensionUiDockRegion =
  | "left-sidebar"
  | "right-sidebar"
  | "player-aside"
  | "bottom-dock";

export interface ExtensionUiComponentProps {
  readonly slot: ExtensionUiSlotId;
}

export interface ExtensionUiModalComponentProps {
  readonly input?: JsonValue;
  close(result?: JsonValue): void;
}

export interface ExtensionUiViewComponentProps {
  /** Globally owner-qualified contribution ID. */
  readonly viewId: string;
  readonly region: ExtensionUiViewRegion;
  /** Once opened, inactive views remain mounted so local state survives. */
  readonly active: boolean;
}

/** Declarative native UI contribution suitable for future restricted mode. */
export interface ExtensionUiNoticeDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly slot: ExtensionUiSlotId;
  readonly kind: "notice";
  readonly title: string;
  readonly message: string;
  readonly tone?: ExtensionUiNoticeTone;
  readonly order?: number;
}

export interface ExtensionUiRegistration extends ExtensionDisposable {
  readonly id: string;
}

// === Panel controls ===

/**
 * Props handed to a rich panel control. Values crossing this boundary are cloned
 * in both directions, so mutating them has no effect on host state; commit
 * instead.
 */
export interface ExtensionPanelControlProps {
  /** Live parameter values of the transformation this control is mounted in. */
  readonly values: Readonly<Record<string, JsonValue>>;
  readonly transformId?: string;
  readonly disabled: boolean;
  /** Source-media time domain, for controls that transfer animated values. */
  readonly sourceTimeRange?: {
    readonly minTime: number;
    readonly duration: number;
  };
  /** Placement config, or the custom control's `config`. Empty when unset. */
  readonly config: Readonly<Record<string, JsonValue>>;

  /**
   * Commits through the host panel's own path, so live preview, undo, history,
   * and keyframe handling all behave as they do for built-in controls. Commits
   * to parameters outside the control's allowlist are rejected and reported.
   */
  commitParameter(name: string, value: JsonValue): void;
  commitParameters(values: Readonly<Record<string, JsonValue>>): void;
}

/**
 * Mounts a control into a host-declared panel zone. The host owns the placement
 * catalogue; an extension cannot invent a target.
 */
export interface ExtensionPanelControlPlacement {
  readonly target: {
    readonly kind: "filter";
    readonly filterName: string;
    readonly zone: string;
  };
  readonly order?: number;
  readonly config?: Readonly<Record<string, JsonValue>>;
}

export interface ExtensionPanelControlDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly kind: "trusted-react";
  readonly component: (props: ExtensionPanelControlProps) => unknown;
  /** Omit to use the control only inside this extension's own transformations. */
  readonly placements?: readonly ExtensionPanelControlPlacement[];
}

export interface ExtensionPanelControlRegistration extends ExtensionDisposable {
  readonly id: string;
}

// === Commands and keybindings ===

/**
 * Declarative predicate over host-published context keys (e.g. `project.open`,
 * `focus.region`, `selection.clipCount`). Keys are host-curated; an unknown key
 * evaluates as `undefined`. A bare `{ key }` tests JavaScript truthiness.
 */
export type ExtensionContextKeyExpression =
  | { readonly key: string }
  | { readonly key: string; readonly equals: JsonValue }
  | { readonly not: ExtensionContextKeyExpression }
  | { readonly and: readonly ExtensionContextKeyExpression[] }
  | { readonly or: readonly ExtensionContextKeyExpression[] };

export type ExtensionCommandSource =
  | "menu"
  | "keybinding"
  | "palette"
  | "toolbar"
  | "api";

/**
 * One command invocation. `subject` is the detached, JSON-serialisable subject
 * of the invoking surface (a menu's subject, a palette argument), never a live
 * host object.
 */
export interface ExtensionCommandInvocation {
  readonly subject?: JsonValue;
  readonly source: ExtensionCommandSource;
}

/**
 * A declarative command in the host's single command table. Menus, keybindings,
 * and future palette/toolbar surfaces are projections of this table. `when`
 * gates enablement declaratively so it stays evaluable in a future restricted
 * profile; a command whose `when` is false is not executed.
 */
export interface ExtensionCommandDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly title: string;
  /** Optional trusted icon component rendered by command-projecting surfaces. */
  readonly icon?: () => unknown;
  readonly when?: ExtensionContextKeyExpression;
  readonly run: (
    invocation: ExtensionCommandInvocation,
  ) => void | Promise<void>;
}

/**
 * A requested chord for one of this extension's commands, e.g. "Mod+Shift+K"
 * ("Mod" is Ctrl, or Cmd on macOS). Bindings that collide with an existing
 * active binding — including chords the host has reserved for its own
 * shortcuts — register as inactive with a diagnostic instead of failing
 * activation; the host arbitrates dispatch through its editor focus regions.
 */
export interface ExtensionKeybindingRequest {
  readonly id: string;
  readonly apiVersion: 1;
  readonly chord: string;
  /**
   * Local command ID registered by the same extension. The command must
   * already be registered when the keybinding is requested.
   */
  readonly command: string;
  /** Editor focus regions the binding is active in; omit for global. */
  readonly regions?: readonly string[];
}

export interface ExtensionCommandApi {
  register(definition: ExtensionCommandDefinition): ExtensionUiRegistration;
  registerKeybinding(
    request: ExtensionKeybindingRequest,
  ): ExtensionUiRegistration;
  /**
   * Executes one of this extension's own commands by local ID, or a host
   * command the host has opted in, by its full dotted ID. Resolves `true` when
   * the command ran and `false` when its `when` clause was false — a disabled
   * command is a state of the editor, not an error.
   *
   * Throws for an unregistered ID, or for a host command that has not opted
   * in: host commands are an authority surface, and contributing a menu item
   * the *user* invokes remains the intended path. No host command opts in
   * today; each grant is reviewed individually at its definition site.
   */
  execute(commandId: string, subject?: JsonValue): Promise<boolean>;
  /** Reads one context key, detached. Unknown keys return `undefined`. */
  getContextKey(key: string): JsonValue | undefined;
  /**
   * Publishes one context key of your own. The host qualifies it as
   * `extension.<yourId>.<key>`, which is the name any `when` clause — yours or
   * another package's — must use to read it. Host keys stay host-owned: a
   * package can add state to the editor's vocabulary, not redefine it.
   *
   * `undefined` clears the key, and every key you wrote is cleared when you
   * deactivate, so a stale state cannot outlive the package that meant it.
   *
   * Returns the qualified name. Values must be finite JSON; anything else, or
   * a malformed key, throws.
   */
  setContextKey(key: string, value: JsonValue | undefined): string;
  /**
   * Fires when any host context key changes. Payload-free: re-read the keys
   * you care about with `getContextKey`. Prefer a declarative `when` on the
   * command itself — this is for extension-owned UI that has to mirror host
   * enablement, not for gating execution.
   */
  subscribeContextKeys(listener: () => void): () => void;
}

/**
 * One option contributed to a host-declared catalogue (a named, extensible
 * option list behind a host dropdown). `value` must satisfy the catalogue's
 * declared value schema — catalogues are not a generic data bus — and is
 * cloned and frozen on registration. `when` gates visibility over host
 * context keys.
 */
export interface ExtensionCatalogueOptionContribution {
  /** Local ID; the host qualifies it as `extensionId/id`. */
  readonly id: string;
  readonly apiVersion: 1;
  /** Host catalogue ID; discover catalogues via `catalogues.listCatalogues()`. */
  readonly catalogueId: string;
  readonly label: string;
  readonly value: JsonValue;
  readonly order?: number;
  readonly when?: ExtensionContextKeyExpression;
}

/** A catalogue option as read back through the API, detached. */
export interface ExtensionCatalogueOptionView {
  readonly id: string;
  readonly label: string;
  readonly value: JsonValue;
  readonly order: number;
}

/** One host catalogue extensions can contribute to, with value discovery. */
export interface ExtensionCatalogueInfo {
  readonly id: string;
  /**
   * Host-owned, serialisable structural description of the catalogue's
   * option values. Documentation-grade: the host's value validation is
   * authoritative.
   */
  readonly valueSchema: JsonValue;
}

export interface ExtensionCatalogueApi {
  /** Contribute one option to a host catalogue. */
  addOption(
    option: ExtensionCatalogueOptionContribution,
  ): ExtensionUiRegistration;
  /** Currently visible options of one catalogue (host and extension), detached. */
  list(catalogueId: string): readonly ExtensionCatalogueOptionView[];
  /** Enumerate catalogue IDs the host has declared, with value schema info. */
  listCatalogues(): readonly ExtensionCatalogueInfo[];
  /**
   * Fires when any catalogue's contents change — including options registered
   * by *other* extensions, which is why polling `list()` is not enough for UI
   * built on a catalogue.
   */
  subscribe(listener: () => void): () => void;
  /** Monotonic change token matching `subscribe` notifications. */
  getRevision(): number;
}

export interface ExtensionCanvasPointerEvent {
  readonly kind: "down" | "move" | "up" | "cancel";
  /** Project pixels in the player viewport's top-left-origin coordinate space. */
  readonly projectPoint: ExtensionPoint2D;
  readonly screenPoint: ExtensionPoint2D;
  readonly pressure: number;
  readonly buttons: number;
  readonly modifiers: {
    readonly shift: boolean;
    readonly alt: boolean;
    readonly ctrl: boolean;
    readonly meta: boolean;
  };
}

export interface ExtensionCanvasToolSession {
  /** Host-owned transient Pixi container, emptied when the tool deactivates. */
  readonly overlay: object;
  /** Clip selected when this tool became active, before host selection paused. */
  readonly targetClipId: string | null;
  projectToScreen(point: ExtensionPoint2D): ExtensionPoint2D;
  screenToProject(point: ExtensionPoint2D): ExtensionPoint2D;
  requestRender(): void;
}

export interface ExtensionCanvasToolDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly label: string;
  readonly icon?: () => unknown;
  readonly cursor?: string;
  readonly when?: ExtensionContextKeyExpression;
  activate(session: ExtensionCanvasToolSession): void;
  deactivate(): void;
  onPointer(event: ExtensionCanvasPointerEvent): void;
}

export interface ExtensionCanvasToolRegistration extends ExtensionUiRegistration {
  /** Local command ID for keybinding requests. */
  readonly command: string;
}

export interface ExtensionCanvasToolApi {
  register(
    definition: ExtensionCanvasToolDefinition,
  ): ExtensionCanvasToolRegistration;
}

// === Notifications ===

export type ExtensionNotificationTone = "info" | "success" | "warning" | "error";

export interface ExtensionToastRequest {
  readonly message: string;
  readonly tone?: ExtensionNotificationTone;
  /** Auto-dismiss delay. `0` keeps the toast until it is dismissed. */
  readonly durationMs?: number;
}

export interface ExtensionNotificationHandle extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionTaskRequest {
  readonly title: string;
  readonly message?: string;
  /** 0 to 1. Omit for an indeterminate task. */
  readonly progress?: number;
  readonly tone?: ExtensionNotificationTone;
  /**
   * Supplying this shows a cancel affordance. The host calls it and leaves the
   * entry in place: cancelling *asks* the work to stop, and only the work knows
   * when it actually has — settle the task once it does.
   */
  readonly onCancel?: () => void;
}

export interface ExtensionTaskUpdate {
  readonly message?: string;
  /** 0 to 1, or `null` for indeterminate. Omit to leave it unchanged. */
  readonly progress?: number | null;
  readonly tone?: ExtensionNotificationTone;
}

export interface ExtensionTaskSettleRequest {
  /** Leaves a final toast. Omit the whole request to settle silently. */
  readonly message?: string;
  readonly tone?: ExtensionNotificationTone;
  readonly durationMs?: number;
}

/** One running task the user can see, and cancel when you allow it. */
export interface ExtensionTaskHandle extends ExtensionDisposable {
  readonly id: string;
  /** Omitted fields keep their current value. Ignored once settled. */
  update(update: ExtensionTaskUpdate): void;
  /** Ends the task, optionally leaving a toast behind. Idempotent. */
  settle(result?: ExtensionTaskSettleRequest): void;
}

/**
 * Where long-running extension work reports to. A toast says something
 * happened; a task says something *is happening* and stays until it settles.
 *
 * Both are owned by the extension: everything it posts is removed when it
 * deactivates, so a package that dies mid-task cannot leave a spinner behind.
 * Neither is a dialog — use `ui.openModal` when you need an answer.
 */
export interface ExtensionNotificationApi {
  toast(request: ExtensionToastRequest): ExtensionNotificationHandle;
  task(request: ExtensionTaskRequest): ExtensionTaskHandle;
}

// === Scopes ===

/** One sampled composited frame, as the scope dock reads it back. */
export interface ExtensionScopeFrame {
  /**
   * Premultiplied RGBA bytes, row-major, `width * height * 4` long.
   *
   * This is the host's own buffer and it is only valid for the duration of the
   * `render` call. Copy anything you need to keep; retaining it hands you a
   * buffer the next sample has already overwritten.
   */
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** Host clock reading when the frame was sampled, in milliseconds. */
  readonly sampledAt: number;
}

export interface ExtensionScopeRenderContext {
  /**
   * The host's 2D context, already sized to `width`/`height` and filled with
   * the dock's background. Draw into it; do not resize or detach it.
   */
  readonly context: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  readonly frame: ExtensionScopeFrame;
}

/**
 * A video scope: a label in the dock and a function that draws one sampled
 * frame. Contributed scopes sit in the same tab strip as the host's waveform,
 * parade, vectorscope, and histogram because they go through the same registry.
 *
 * `render` is on a sampling loop that runs while the dock is open. Keep it
 * synchronous and allocation-light; a throw is isolated and reported, but a
 * scope that throws every frame is a scope nobody can read.
 */
export interface ExtensionScopeDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly kind: "trusted-scope";
  readonly label: string;
  /**
   * Backing pixel size of the drawing surface, 16 to 2048 on each axis. The
   * dock scales the result to the available width, so this is the resolution
   * you draw at, not the size you appear at.
   */
  readonly width: number;
  readonly height: number;
  readonly order?: number;
  render(context: ExtensionScopeRenderContext): void;
}

export interface ExtensionScopeRegistration extends ExtensionDisposable {
  readonly id: string;
}

export interface ExtensionScopeApi {
  register(definition: ExtensionScopeDefinition): ExtensionScopeRegistration;
}

export interface ExtensionUiApi {
  /** The host command table and chord requests (see `ExtensionCommandApi`). */
  readonly commands: ExtensionCommandApi;
  /** Command placements in host menus (see `ExtensionMenuApi`). */
  readonly menus: ExtensionMenuApi;
  /** Option contributions to host dropdown catalogues (see `ExtensionCatalogueApi`). */
  readonly catalogues: ExtensionCatalogueApi;
  /** Exclusive trusted interaction modes over the player canvas. */
  readonly canvasTools: ExtensionCanvasToolApi;
  /** Toasts and progress entries for long-running work. */
  readonly notifications: ExtensionNotificationApi;
  /** Video scopes in the host's bottom dock. */
  readonly scopes: ExtensionScopeApi;
  /**
   * Registers a rich React control. Use it in an extension transformation's own
   * groups via a `custom` control, or place it in a host panel zone, or both.
   */
  registerPanelControl(
    definition: ExtensionPanelControlDefinition,
  ): ExtensionPanelControlRegistration;
  registerNotice(
    definition: ExtensionUiNoticeDefinition,
  ): ExtensionUiRegistration;
  registerComponent(
    definition: ExtensionTrustedUiComponentDefinition,
  ): ExtensionUiRegistration;
  /**
   * Registers a blocking dialog, opened with `openModal`.
   *
   * **A modal cannot accept library drags.** The modal host is app-wide — it
   * has to work on the projects page, before any project is open — so it
   * mounts *outside* the editor's drag context, and a `runtime.panelUi` drop
   * slot inside a modal never fires, with no error to debug. Views do mount
   * inside it: use a view region, `editor-overlay` for a floating workspace
   * that stays open over the editor.
   */
  registerModal(
    definition: ExtensionTrustedUiModalDefinition,
  ): ExtensionUiRegistration;
  /** Registers a trusted view in one host-owned shell region. */
  registerView(
    definition: ExtensionTrustedUiViewDefinition,
  ): ExtensionUiRegistration;
  /**
   * Registers a body that replaces one host panel's own, inside its frame.
   *
   * For the shape the mask panel has natively — a panel, then a detail view
   * that takes its place with a back control — where a second view would be a
   * second *tab* and a floating panel would not be in the panel at all.
   *
   * The target does not have to exist yet — panels are declared by the modules
   * that render them, and the editor loads lazily, so register whenever you
   * activate and let `openPanelTakeover` tell you whether the panel is there.
   * It returns `target_unavailable` when the host does not offer that panel,
   * which is the signal to fall back to a surface that always exists.
   *
   * Only one takeover shows in a panel at a time, and the frame renders the
   * back control, so the user can always have the panel back.
   */
  registerPanelTakeover(
    definition: ExtensionPanelTakeoverDefinition,
  ): ExtensionUiRegistration;
  /** Shows one of this extension's takeovers in its target panel. */
  openPanelTakeover(id: string): ExtensionPanelTakeoverResult;
  /** Hands the panel back. Does not fire `onDismissed`, which is the user's. */
  closePanelTakeover(id: string): void;
  /**
   * View ids of the panels the host currently allows a takeover of.
   *
   * Discovery, not a gate: panels appear as their modules load, so an empty
   * list at activation says nothing about what will exist by the time the user
   * asks. Register regardless and branch on `openPanelTakeover`'s result.
   */
  listPanelTakeoverTargets(): readonly string[];
  /** Opens one modal registered by the calling extension. */
  openModal(id: string, input?: JsonValue): Promise<JsonValue | undefined>;
  /** Selects one visible view registered by the calling extension. */
  openView(id: string): boolean;
}

/**
 * Arbitrary React component rendered inside a host-owned, isolated slot.
 *
 * `slot` is either one of the host's fixed slot ids or an *anchor*: a slot the
 * host emits for one structural element of a panel, named after it — e.g.
 * `generation.section.prompts.after` for the point below the Prompts section
 * of the generation panel. The host owns where anchors are emitted and what
 * they are called; registering against anything it has not declared throws.
 */
export interface ExtensionTrustedUiComponentDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly slot: ExtensionUiSlotId;
  readonly kind: "trusted-react";
  readonly order?: number;
  /**
   * Declarative visibility over host context keys. A contribution whose
   * clause is false is never mounted — prefer it to mounting and returning
   * null, so the slot stays empty rather than rendering an empty wrapper.
   *
   * Conditions the key vocabulary cannot express — "is the mounted workflow a
   * MiniMax one" — still belong inside the component, which can read the live
   * session and render nothing.
   */
  readonly when?: ExtensionContextKeyExpression;
  readonly component: (props: ExtensionUiComponentProps) => unknown;
}

/** Arbitrary trusted React rendered inside a host-owned MUI dialog. */
export interface ExtensionTrustedUiModalDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly kind: "trusted-modal";
  readonly title: string;
  readonly size?: ExtensionUiModalSize;
  readonly component: (props: ExtensionUiModalComponentProps) => unknown;
}

export interface ExtensionPanelTakeoverComponentProps {
  /** Owner-qualified id of this takeover. */
  readonly takeoverId: string;
  /** The panel being replaced. */
  readonly viewId: string;
  /** Hands the panel back from inside the body. */
  close(): void;
}

export interface ExtensionPanelTakeoverDefinition {
  /** Package-local; the host qualifies it as `<extensionId>/<id>`. */
  readonly id: string;
  readonly apiVersion: 1;
  readonly kind: "trusted-react";
  /**
   * The host panel to replace, by its view id — `host.generate`, say.
   * Discover them with `listPanelTakeoverTargets`; a panel that has not opted
   * in is not a target and registration throws.
   */
  readonly targetViewId: string;
  /** Shown in the frame's back bar, so the user knows what took the panel. */
  readonly title: string;
  readonly component: (props: ExtensionPanelTakeoverComponentProps) => unknown;
  /**
   * Called when the *user* hands the panel back, never on your own
   * `closePanelTakeover` or `dispose`. Stop tracking the panel here.
   */
  readonly onDismissed?: () => void;
}

export type ExtensionPanelTakeoverResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "unavailable"
        | "not_registered"
        /** The panel is gone, or no longer allows being taken over. */
        | "target_unavailable"
        /** Another package is showing there; it is not displaced. */
        | "target_busy";
      readonly message: string;
    };

/** Arbitrary trusted React rendered in a host-owned shell region. */
export interface ExtensionTrustedUiViewDefinition {
  readonly id: string;
  readonly apiVersion: 1;
  readonly kind: "trusted-view";
  readonly title: string;
  readonly icon?: () => unknown;
  readonly defaultRegion: ExtensionUiViewRegion;
  /**
   * Additional regions the *user* may move this view to, from "Manage panels".
   * Omit it and the view stays wherever it was registered.
   *
   * Must include `defaultRegion`, must be non-empty, and may name only docked
   * regions — so a view whose `defaultRegion` is `editor-overlay` or
   * `projects-page.main` cannot declare it at all. Registration **throws** on
   * any of those, failing activation, rather than silently ignoring the list.
   *
   * Opting in changes how the view is mounted: a portable panel is rendered
   * once from a fixed position and adopted into whichever region shows it, so
   * a move preserves React state, effects and DOM instead of remounting. In
   * exchange the view must tolerate `region` changing underneath it — read it
   * from props rather than assuming the one it was registered with.
   */
  readonly allowedRegions?: readonly ExtensionUiDockRegion[];
  readonly order?: number;
  readonly when?: ExtensionContextKeyExpression;
  readonly component: (props: ExtensionUiViewComponentProps) => unknown;
}

/**
 * Declarative visibility predicate for one menu placement, evaluated by the
 * host against context keys and the menu's detached subject. Menu placements
 * never carry executable visibility callbacks, so conditions stay evaluable
 * in a future restricted profile.
 */
export type ExtensionMenuCondition =
  | { readonly context: ExtensionContextKeyExpression }
  | {
      readonly subject: {
        /** JSON object path; a missing path makes the predicate false. */
        readonly path: readonly string[];
        readonly equals?: JsonValue; // omitted means a truthy test
      };
    }
  | { readonly not: ExtensionMenuCondition }
  | { readonly all: readonly ExtensionMenuCondition[] }
  | { readonly any: readonly ExtensionMenuCondition[] };

/**
 * Places one of this extension's registered commands in a host menu. The host
 * renders the native item from the command definition (title, icon,
 * enablement via the command's `when`); invoking it executes the command with
 * the menu's schema-validated subject as detached `JsonValue`. Registration
 * rejects unknown menu IDs and commands not registered by the same extension;
 * disposing the command makes a remaining placement inert with a diagnostic
 * until the placement is disposed.
 */
export interface ExtensionMenuCommandContribution {
  readonly id: string;
  readonly apiVersion: 1;
  /** Host menu ID; discover catalogued menus via `menus.listMenus()`. */
  readonly menuId: string;
  readonly kind: "command";
  /** Local ID of a command already registered by this extension. */
  readonly command: string;
  /** Ordering group, e.g. "9_extensions". Groups sort lexically. */
  readonly group: string;
  readonly order?: number;
  /** Visibility only; command-level `when` still governs enablement everywhere. */
  readonly when?: ExtensionMenuCondition;
}

/** One host menu extensions can contribute to, with subject discovery info. */
export interface ExtensionMenuInfo {
  readonly id: string;
  /**
   * Host-owned, serialisable structural description of the menu's detached
   * subject (field paths to type-name strings). Documentation-grade: the
   * host's subject schema validation is authoritative.
   */
  readonly subjectSchema: JsonValue;
}

export interface ExtensionMenuApi {
  /** Place one of this extension's registered commands in a host menu. */
  addItem(definition: ExtensionMenuCommandContribution): ExtensionUiRegistration;
  /** Enumerate menu IDs the host has catalogued, with subject schema info. */
  listMenus(): readonly ExtensionMenuInfo[];
}

/** Where one attached media item's value came from. */
export type ExtensionGenerationMediaSource =
  | "asset"
  /** A range of the user's timeline, rendered at submission. */
  | "timeline-selection"
  /** A still captured from the player, which is not a library asset. */
  | "frame";

/** One occupied slot of a media input, as the graph will receive it. */
export interface ExtensionGenerationMediaItem {
  /**
   * The address every media write takes — **positional, not an identity**.
   *
   * A repeatable input's slot ids follow position, and the panel front-packs
   * the batch whenever the arrangement changes, so removing or moving an item
   * **renames every slot after it**. Appending, or setting an option, renames
   * nothing. This id names this item only while the batch stands still.
   *
   * Inside a `transaction` that is handled for you: pass the ids you read from
   * the snapshot and they keep naming the items you meant, however the
   * transaction's own commands renumber things. Outside one they go stale —
   * do not store a slot id and come back to it later, re-read the session. A
   * write whose ids have gone stale fails `media_not_found`, or
   * `session_changed` if the panel moved while your callback ran.
   */
  readonly slotId: string;
  /**
   * The attachment's identity — **stable, and never an address**. Since SDK
   * 1.26.0.
   *
   * Minted when the media is attached and kept while it is reordered,
   * compacted, toggled or prepared, so anything you author that refers to
   * "this reference" should hold the `itemId`, not the slot or the ordinal.
   * Replacing the slot's media is a new attachment with a new id, and the same
   * asset attached twice has two — a reference to a removed item stays
   * unresolved rather than moving onto whatever took its place.
   *
   * Writes still take `slotId`. In a staged draft, an attached item carries
   * its id from the moment it is staged and keeps it once committed.
   */
  readonly itemId: string;
  /**
   * Position among *filled* slots — the delivery position, and the number a
   * reference tag's ordinal counts. Never infer order from `slotId`.
   */
  readonly ordinal: number;
  readonly source: ExtensionGenerationMediaSource;
  /** Library assets only; resolve it through `assets.get`. */
  readonly assetId?: string;
  readonly displayName: string;
  /** Host-owned preview URL, including timeline captures. */
  readonly thumbnail?: string;
  /** What the slot delivers: a video on an audio slot presents as `audio`. */
  readonly mediaType: "image" | "video" | "audio";
  /**
   * The item really carries a soundtrack. `null` is the host declining to
   * guess — an unrendered timeline selection, or a video ingested before the
   * flag was probed — not "no".
   */
  readonly hasAudio: boolean | null;
  /**
   * Per-item switches this input offers for this item, with their current
   * state; write one with `setMediaOption`. Absent keys are not available.
   */
  readonly options: Readonly<Record<string, boolean>>;
  /** Still rendering or extracting, so its value is not final. */
  readonly preparing: boolean;
}

/** A media input that holds an ordered batch rather than a single item. */
export interface ExtensionGenerationInputRepeatable {
  readonly max: number;
  /** Per-item switch ids this input offers, e.g. `["audio"]`. */
  readonly optionIds: readonly string[];
}

export interface ExtensionGenerationInputSnapshot {
  readonly id: string;
  readonly nodeId: string;
  readonly param: string;
  readonly label: string;
  readonly description?: string;
  readonly inputType: "text" | "image" | "video" | "audio";
  /** Text inputs only. A media input's contents are in `media`. */
  readonly value?: JsonValue;
  /** Repeatable (batch) media inputs only. */
  readonly repeatable?: ExtensionGenerationInputRepeatable;
  /**
   * Media inputs only: the occupied slots, in delivery order. Present and
   * empty for a media input with nothing attached; absent for a text input.
   *
   * A slot still being prepared before its value exists is not listed — there
   * is no media to describe and the graph has nothing to deliver from it. It
   * is still taken: see `reservedSlotIds`.
   */
  readonly media?: readonly ExtensionGenerationMediaItem[];
  /**
   * Slots held open for a value still being produced — a timeline selection
   * rendering, a frame being captured. They are absent from `media` but are
   * *not* free, so the room left in a batch is
   * `repeatable.max - media.length - reservedSlotIds.length`, never
   * `max - media.length`. An `attachAsset` skips them for you.
   *
   * While this is non-empty the input refuses any write that repacks the batch
   * — `moveMedia`, `removeMedia`, and a positioned `attachAsset` — with
   * `input_busy`. It empties on its own when the media lands, and the session
   * republishes, so waiting for that is the whole retry strategy.
   */
  readonly reservedSlotIds?: readonly string[];
}

/** One widget-backed parameter of one node in the mounted workflow. */
export interface ExtensionGenerationWidgetTarget {
  /**
   * Execution id: `<id>` at the root, `<instanceId>:<innerId>` for a node
   * inside a subgraph instance — the same ids the submitted prompt uses.
   */
  readonly nodeId: string;
  readonly widget: string;
}

export type ExtensionGenerationWidgetValueType =
  | "int"
  | "float"
  | "string"
  | "boolean"
  | "enum"
  | "unknown";

export interface ExtensionGenerationWidgetSnapshot {
  readonly nodeId: string;
  readonly param: string;
  /** `unknown` when the host has no `object_info` entry describing it. */
  readonly valueType: ExtensionGenerationWidgetValueType;
  /** `null` when the graph carries nothing representable as finite JSON. */
  readonly value: JsonValue | null;
  readonly defaultValue: JsonValue | null;
  /** Enum options where the host knows them; `null` otherwise. */
  readonly options: readonly (string | number | boolean)[] | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly step: number | null;
  /** Fed by a node connection, so it carries no editable widget value. */
  readonly linked: boolean;
  /**
   * The panel renders a control for this widget, so `setWidget` can write it.
   * Every other widget is readable but fails `widget_not_editable`; reach those
   * through a submission effect instead of guessing.
   */
  readonly editable: boolean;
}

export interface ExtensionGenerationNodeSnapshot {
  readonly id: string;
  readonly classType: string;
  readonly title: string;
  /** LiteGraph node mode: 0 = always, 2 = muted, 4 = bypassed. */
  readonly mode: number;
  readonly widgets: readonly ExtensionGenerationWidgetSnapshot[];
}

/**
 * The mounted workflow's node and widget catalogue.
 *
 * Deliberately class-and-widget only: there are no inputs, ports, links, raw
 * ComfyUI metadata, or LiteGraph objects here, so a consumer can match node
 * classes and inspect their widgets but cannot infer what a node is wired to.
 */
export interface ExtensionGenerationWorkflowSnapshot {
  readonly sourceId: string | null;
  /** `null` before the ComfyUI bridge has reported the instance identity. */
  readonly instanceId: string | null;
  /** Bumps when workflow identity or the node catalogue changes. */
  readonly revision: number;
  readonly fingerprint: string;
  readonly mode: "catalogue" | "temporary" | "manual";
  readonly nodes: readonly ExtensionGenerationNodeSnapshot[];
}

/**
 * A detached, deeply frozen projection of the mounted generation session. The
 * same object is returned until something changes, so it is safe to pass
 * straight to `useSyncExternalStore`.
 */
export interface ExtensionGenerationSessionSnapshot {
  readonly workflow: ExtensionGenerationWorkflowSnapshot;
  /** `error` means the workflow failed to load, not that a run failed. */
  readonly status: "loading" | "ready" | "error";
  readonly inputs: readonly ExtensionGenerationInputSnapshot[];
  /** The panel would accept a submission now: connection, readiness, inputs. */
  readonly canSubmit: boolean;
  /** A generation is queued, running, or being pre/post-processed. */
  readonly busy: boolean;
}

export interface ExtensionGenerationAttachOptions {
  /** Position among the filled slots; defaults to after the last one. */
  readonly at?: number;
  /**
   * Per-item switches for the item being attached, keyed by option id. Only
   * ids the input offers for *this* asset are accepted; anything else fails
   * with `option_not_available`.
   */
  readonly itemOptions?: Readonly<Record<string, boolean>>;
}

/**
 * A labelled, atomic batch of panel writes. Nothing applies unless every
 * staged command validates.
 *
 * Media commands are ordered and cumulative: each is judged against the state
 * the ones before it left, so attaching three assets in one transaction fills
 * three slots, and attaching a video then toggling its `audio` switch works.
 * Every media write is validated exactly as the equivalent drag would be — an
 * extension cannot place an asset a user could not drag into the same slot.
 *
 * **Slot ids name the session as you read it.** A repeatable input's slot ids
 * are positional, so removing or moving an item renames the ones after it. The
 * transaction accounts for that: pass the ids the snapshot showed, and it
 * translates them as its own commands renumber the batch. Ordinals are not
 * translated — a position is a position — and a slot created inside the
 * transaction has no id you could name, which is why `attachAsset` takes
 * `itemOptions` instead. If the panel republishes its inputs while your
 * callback runs, the write fails `session_changed` rather than landing on
 * whatever moved into place.
 */
export interface ExtensionGenerationTransaction {
  setTextInput(inputId: string, value: string): void;
  /** Write one widget the active snapshot marks `editable`. */
  setWidget(target: ExtensionGenerationWidgetTarget, value: JsonValue): void;
  /**
   * Attach a library asset to a media input.
   *
   * `at` is a position among the filled slots, defaulting to after the last
   * one; a single-slot input takes only position 0 and replaces what it holds,
   * exactly as a drop on it would. Which *slot* that becomes is the host's to
   * work out — an append skips slots the panel is holding open for a value
   * still being produced.
   *
   * Appending always works. Passing an `at` that is not the end repacks the
   * batch, so it fails with `input_busy` while `reservedSlotIds` is non-empty.
   *
   * `itemOptions` sets per-item switches on the item this attach creates.
   * They belong here rather than in a following `setMediaOption` because the
   * new item has no slot id to name until the transaction commits, and
   * splitting the write in two would make it non-atomic.
   */
  attachAsset(
    inputId: string,
    assetId: string,
    options?: ExtensionGenerationAttachOptions,
  ): void;
  /**
   * Reorder within one repeatable input, by delivery position.
   *
   * Fails with `input_busy` while the input has `reservedSlotIds`: reordering
   * repacks the batch, which would move another item into the slot a pending
   * render is about to write, and the host cannot cancel that render.
   */
  moveMedia(inputId: string, fromOrdinal: number, toOrdinal: number): void;
  /**
   * Also `input_busy` while the input has `reservedSlotIds`; see `moveMedia`.
   *
   * Pass the slot id as the snapshot showed it. Removing an item renumbers the
   * batch, but the transaction translates the ids you read as its own commands
   * advance, so two removals take the two ids you saw rather than the second
   * one's new name.
   */
  removeMedia(inputId: string, slotId: string): void;
  /**
   * Write one per-item switch. Only the ids the slot's snapshot lists in
   * `options` are available; slot ids are unique across the panel, so no input
   * id is needed.
   */
  setMediaOption(slotId: string, optionId: string, value: boolean): void;
}

export type ExtensionGenerationTransactionResult =
  | { readonly ok: true; readonly changed: boolean; readonly label: string }
  | {
      readonly ok: false;
      readonly code:
        | "unavailable"
        | "invalid_label"
        | "invalid_command"
        | "input_not_found"
        | "input_type_mismatch"
        | "widget_not_found"
        | "widget_not_editable"
        | "widget_value_invalid"
        /** A reorder was asked of an input that holds a single slot. */
        | "input_not_repeatable"
        | "asset_not_found"
        /** The slot would not accept that asset from a drag either. */
        | "asset_type_rejected"
        | "batch_full"
        | "ordinal_out_of_range"
        /** The addressed slot holds nothing, so there is nothing to change. */
        | "media_not_found"
        /**
         * The input is holding a slot open for media still being produced, and
         * the change would repack the batch underneath it. Retryable: watch
         * `reservedSlotIds` and try again once it is empty.
         */
        | "input_busy"
        | "option_not_available"
        /**
         * The panel republished its inputs while your callback ran, so the
         * slot ids you staged name items that have since moved. Nothing was
         * written. Retryable: read the session again and restage against the
         * ids it now reports.
         */
        | "session_changed"
        | "callback_failed";
      readonly message: string;
      readonly label: string;
    };

/**
 * One host-supported change to the graph a submission is built from. The union
 * is closed: it is not a general graph patch, and every kind names its own
 * invariant, conflict rule, and validation owner.
 */
export type ExtensionGenerationGraphEffect =
  | { readonly kind: "bypass-nodes"; readonly nodeIds: readonly string[] }
  | {
      readonly kind: "set-widget";
      readonly target: ExtensionGenerationWidgetTarget;
      readonly value: JsonValue;
    };

export interface ExtensionGenerationSubmissionContext {
  /** The session the submission is planned from, detached and frozen. */
  readonly session: ExtensionGenerationSessionSnapshot;
}

/**
 * A contributor plans graph effects for a submission.
 *
 * `contribute` runs once per submission, synchronously, and must be
 * deterministic for the context it is given: the host stores what it returns
 * in the queued plan and replays that, so it is never asked again — a queued
 * generation is unaffected by later UI changes, a workflow switch, or this
 * package being disabled.
 *
 * Effects address the *graph*, not the panel, so they can reach a widget with
 * no panel control — which `transaction().setWidget` cannot. A throw, an
 * unknown target, or a value the widget does not accept fails the submission
 * before any GPU work, attributed to this contribution.
 */
export interface ExtensionGenerationSubmissionContributorDefinition {
  /** Package-local; the host qualifies it as `<extensionId>/<id>`. */
  readonly id: string;
  readonly apiVersion: 1;
  contribute(
    context: ExtensionGenerationSubmissionContext,
  ): readonly ExtensionGenerationGraphEffect[];
}

export interface ExtensionGenerationRegistration extends ExtensionDisposable {
  readonly id: string;
}

/** Props for one rule-selected extension body inside the generation panel. */
export interface ExtensionGenerationSectionProps {
  /** Rule-local placement identity, stable for the mounted workflow. */
  readonly placementId: string;
  readonly sectionId: string;
  /** Whether the host-owned section is expanded; collapsed bodies stay mounted. */
  readonly active: boolean;
  /** Detached, deeply frozen configuration from the workflow rule (≤100k JSON characters). */
  readonly config: Readonly<Record<string, JsonValue>>;
}

export interface ExtensionGenerationSectionDefinition {
  /** Package-local id referenced by a workflow section's contribution_id. */
  readonly id: string;
  readonly apiVersion: 1;
  readonly kind: "trusted-react";
  readonly component: (props: ExtensionGenerationSectionProps) => unknown;
}

export interface ExtensionGenerationUiApi {
  /** Register a section body that workflow rules may explicitly select. */
  registerSection(
    definition: ExtensionGenerationSectionDefinition,
  ): ExtensionGenerationRegistration;
}

export interface ExtensionGenerationTextInputClaimOptions {
  /**
   * Why the box is read-only, shown to the user beside it. Write it for
   * someone who has forgotten the extension exists.
   */
  readonly reason: string;
  /**
   * Called when the *user* takes the input back through "Edit anyway", never
   * on your own `dispose`. Stop tracking the text here: the claim is gone and
   * writing over what the user then types is the failure this exists to stop.
   */
  readonly onRevoked?: () => void;
}

export type ExtensionGenerationClaimResult =
  | { readonly ok: true; readonly registration: ExtensionGenerationRegistration }
  | {
      readonly ok: false;
      readonly code:
        | "unavailable"
        | "input_not_found"
        | "input_type_mismatch"
        | "invalid_reason"
        | "input_already_claimed";
      readonly message: string;
    };

/** User-event API for the currently mounted generation/workflow panel. */
export interface ExtensionGenerationApi {
  readonly ui: ExtensionGenerationUiApi;
  listInputs(): readonly ExtensionGenerationInputSnapshot[];
  /**
   * Take authorship of one text input.
   *
   * While claimed, the panel renders that box read-only with your `reason` and
   * an "Edit anyway" control; the user taking it back revokes the claim and
   * calls `onRevoked`. One claim per input — a second fails with
   * `input_already_claimed` rather than displacing the first. Claims are
   * released by disposing the registration, and die with the activation.
   */
  claimTextInput(
    inputId: string,
    options: ExtensionGenerationTextInputClaimOptions,
  ): ExtensionGenerationClaimResult;
  /** The mounted session, or `null` when no generation panel is mounted. */
  getSession(): ExtensionGenerationSessionSnapshot | null;
  /** Monotonic while the panel stays mounted; pairs with `subscribe`. */
  getRevision(): number;
  /** Payload-free change notification; disposed with the activation. */
  subscribe(listener: () => void): () => void;
  transaction(
    label: string,
    callback: (transaction: ExtensionGenerationTransaction) => void,
  ): ExtensionGenerationTransactionResult;
  /**
   * Open a staged editor over some of the panel's inputs.
   *
   * `null` once the activation has ended. The draft is owned by your
   * activation and disposed with it, which is why it is opened here rather than
   * rendered as a component: it writes to the session, and a write needs an
   * owner. Draw it with `runtime.generationUi.InputsDraftFields`, or read
   * `getState` and draw your own.
   */
  createInputsDraft(
    request: ExtensionGenerationInputsDraftRequest,
  ): ExtensionGenerationInputsDraft | null;
  /** Contribute graph effects to every generation submitted from this panel. */
  registerSubmissionContributor(
    definition: ExtensionGenerationSubmissionContributorDefinition,
  ): ExtensionGenerationRegistration;
}

// === Color ===

export type ColorGradingSpace = "srgb-rec709";

/** The color model a grade was authored against. V1 is the only model today. */
export interface AuthoredColorModelV1 {
  readonly version: 1;
  readonly gradingSpace: ColorGradingSpace;
}

export type ColorRgb = readonly [number, number, number];
/** Premultiplied RGBA, matching the renderer's compositing convention. */
export type ColorRgba = readonly [number, number, number, number];

export interface ColorCurvePoint {
  readonly x: number;
  readonly y: number;
}

/** A parsed `.cube` LUT. Produced by `parseCubeLut` and `bakeColorGradeCube`. */
export interface CubeLut {
  readonly title: string | null;
  readonly dimensions: 1 | 3;
  readonly size: number;
  readonly domainMin: ColorRgb;
  readonly domainMax: ColorRgb;
  /** rgb triples; length = size * 3 (1D) or size³ * 3 (3D). */
  readonly data: Float32Array;
}

/** The seven grade curves. Each is optional; omitted curves are identity. */
export interface ColorCurveSet {
  readonly curveMaster?: readonly ColorCurvePoint[];
  readonly curveR?: readonly ColorCurvePoint[];
  readonly curveG?: readonly ColorCurvePoint[];
  readonly curveB?: readonly ColorCurvePoint[];
  readonly curveHueHue?: readonly ColorCurvePoint[];
  readonly curveHueSat?: readonly ColorCurvePoint[];
  readonly curveLumaSat?: readonly ColorCurvePoint[];
}

export interface ColorCurveSampler {
  at(value: number): number;
}

/**
 * Grade values ready for numeric evaluation: every animatable field is a plain
 * number. Obtain one from `resolve()` or `normalize()`, never by casting
 * persisted parameters.
 */
export interface ColorGradeResolvedParametersV1 {
  readonly colorModel: AuthoredColorModelV1;

  readonly exposure: number;
  readonly temperature: number;
  readonly tint: number;
  readonly contrast: number;
  readonly pivot: number;
  readonly kneeThreshold: number;
  readonly kneeSoftness: number;
  readonly toeAmount: number;
  readonly toeSoftness: number;
  readonly saturation: number;
  readonly vibrance: number;
  readonly hueRotate: number;

  readonly liftR: number;
  readonly liftG: number;
  readonly liftB: number;
  readonly liftMaster: number;
  readonly gammaR: number;
  readonly gammaG: number;
  readonly gammaB: number;
  readonly gammaMaster: number;
  readonly gainR: number;
  readonly gainG: number;
  readonly gainB: number;
  readonly gainMaster: number;
  readonly offsetR: number;
  readonly offsetG: number;
  readonly offsetB: number;
  readonly offsetMaster: number;

  readonly curveMaster: readonly ColorCurvePoint[];
  readonly curveR: readonly ColorCurvePoint[];
  readonly curveG: readonly ColorCurvePoint[];
  readonly curveB: readonly ColorCurvePoint[];
  readonly curveHueHue: readonly ColorCurvePoint[];
  readonly curveHueSat: readonly ColorCurvePoint[];
  readonly curveLumaSat: readonly ColorCurvePoint[];

  readonly qualifierEnabled: boolean;
  readonly hueCenter: number;
  readonly hueWidth: number;
  readonly hueSoftLo: number;
  readonly hueSoftHi: number;
  readonly satLo: number;
  readonly satHi: number;
  readonly satSoftLo: number;
  readonly satSoftHi: number;
  readonly lumaLo: number;
  readonly lumaHi: number;
  readonly lumaSoftLo: number;
  readonly lumaSoftHi: number;
  readonly qualifierInvert: boolean;
  readonly mattePreview: boolean;

  /** Creative LUT slot. References a project asset; the bytes live out of band. */
  readonly lutAssetId: string | null;
  readonly lutIntensity: number;

  readonly ditherStrength: number;
}

export interface ColorGradeSplinePointV1 {
  readonly time: number;
  readonly value: number;
}

/** Legacy host-authored animation retained for grade round trips. */
export interface ColorGradeSplineParameterV1 {
  readonly type: "spline";
  readonly points: readonly ColorGradeSplinePointV1[];
}

export type ColorGradeAuthoredScalarV1 =
  | ExtensionScalarValue
  | ColorGradeSplineParameterV1;

/**
 * Grade values as persisted. An animatable field may hold an authored animation
 * object rather than a number, so these must be resolved at a source time
 * before evaluation. Passing them to `normalize()` throws rather than silently
 * replacing the animation with a default.
 */
export interface ColorGradeAuthoredParametersV1 {
  readonly colorModel: AuthoredColorModelV1;

  readonly exposure?: ColorGradeAuthoredScalarV1;
  readonly temperature?: ColorGradeAuthoredScalarV1;
  readonly tint?: ColorGradeAuthoredScalarV1;
  readonly contrast?: ColorGradeAuthoredScalarV1;
  readonly pivot?: ColorGradeAuthoredScalarV1;
  readonly kneeThreshold?: ColorGradeAuthoredScalarV1;
  readonly kneeSoftness?: ColorGradeAuthoredScalarV1;
  readonly toeAmount?: ColorGradeAuthoredScalarV1;
  readonly toeSoftness?: ColorGradeAuthoredScalarV1;
  readonly saturation?: ColorGradeAuthoredScalarV1;
  readonly vibrance?: ColorGradeAuthoredScalarV1;
  readonly hueRotate?: ColorGradeAuthoredScalarV1;

  readonly liftR?: ColorGradeAuthoredScalarV1;
  readonly liftG?: ColorGradeAuthoredScalarV1;
  readonly liftB?: ColorGradeAuthoredScalarV1;
  readonly liftMaster?: ColorGradeAuthoredScalarV1;
  readonly gammaR?: ColorGradeAuthoredScalarV1;
  readonly gammaG?: ColorGradeAuthoredScalarV1;
  readonly gammaB?: ColorGradeAuthoredScalarV1;
  readonly gammaMaster?: ColorGradeAuthoredScalarV1;
  readonly gainR?: ColorGradeAuthoredScalarV1;
  readonly gainG?: ColorGradeAuthoredScalarV1;
  readonly gainB?: ColorGradeAuthoredScalarV1;
  readonly gainMaster?: ColorGradeAuthoredScalarV1;
  readonly offsetR?: ColorGradeAuthoredScalarV1;
  readonly offsetG?: ColorGradeAuthoredScalarV1;
  readonly offsetB?: ColorGradeAuthoredScalarV1;
  readonly offsetMaster?: ColorGradeAuthoredScalarV1;

  readonly curveMaster?: readonly ColorCurvePoint[];
  readonly curveR?: readonly ColorCurvePoint[];
  readonly curveG?: readonly ColorCurvePoint[];
  readonly curveB?: readonly ColorCurvePoint[];
  readonly curveHueHue?: readonly ColorCurvePoint[];
  readonly curveHueSat?: readonly ColorCurvePoint[];
  readonly curveLumaSat?: readonly ColorCurvePoint[];

  readonly qualifierEnabled?: boolean;
  readonly hueCenter?: ColorGradeAuthoredScalarV1;
  readonly hueWidth?: ColorGradeAuthoredScalarV1;
  readonly hueSoftLo?: ColorGradeAuthoredScalarV1;
  readonly hueSoftHi?: ColorGradeAuthoredScalarV1;
  readonly satLo?: ColorGradeAuthoredScalarV1;
  readonly satHi?: ColorGradeAuthoredScalarV1;
  readonly satSoftLo?: ColorGradeAuthoredScalarV1;
  readonly satSoftHi?: ColorGradeAuthoredScalarV1;
  readonly lumaLo?: ColorGradeAuthoredScalarV1;
  readonly lumaHi?: ColorGradeAuthoredScalarV1;
  readonly lumaSoftLo?: ColorGradeAuthoredScalarV1;
  readonly lumaSoftHi?: ColorGradeAuthoredScalarV1;
  readonly qualifierInvert?: boolean;
  readonly mattePreview?: boolean;

  readonly lutAssetId?: string | null;
  readonly lutIntensity?: ColorGradeAuthoredScalarV1;
  readonly ditherStrength?: ColorGradeAuthoredScalarV1;
}

/** A static partial grade, suitable for presets and direct normalization. */
export type ColorGradeParameterPatchV1 = Readonly<
  Partial<Omit<ColorGradeResolvedParametersV1, "colorModel">>
>;

/** Static grade input; a missing model is interpreted as legacy V1. */
export type ColorGradeStaticInputV1 = ColorGradeParameterPatchV1 &
  Readonly<{ colorModel?: AuthoredColorModelV1 }>;

export interface ColorGradeEvaluatorOptions {
  /** Creative-LUT bytes. Without them the evaluator skips the LUT stage. */
  readonly lut?: CubeLut | null;
}

/** Stage-wise CPU evaluation of a grade, matching the renderer's pipeline. */
export interface ColorGradeEvaluator {
  beforeCurves(color: ColorRgb): ColorRgb;
  curves(color: ColorRgb): ColorRgb;
  afterCurves(color: ColorRgb): ColorRgb;
  composite(input: ColorRgb, graded: ColorRgb): ColorRgb;
  lut(color: ColorRgb): ColorRgb;
  apply(color: ColorRgb): ColorRgb;
}

export type ColorHistogramKind = "luma" | "red" | "green" | "blue" | "hue";
/** Each channel holds `COLOR_HISTOGRAM_BIN_COUNT` normalized bins. */
export type ColorHistograms = Readonly<Record<ColorHistogramKind, Float32Array>>;

export type ColorMatrix3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Reading, computing, and writing V1 color grades. */
export interface ExtensionColorGradeApi {
  /** Catalogue identity of the host's color grade. */
  readonly filterName: "ColorGradeFilter";
  readonly defaults: ColorGradeResolvedParametersV1;

  /**
   * Returns the authored grade carried by a transform, or `null` if the
   * transform is not a color grade. Fails closed on an unsupported color model
   * rather than coercing a future grade into V1.
   */
  parseTransform(
    transform: ExtensionTimelineTransformSnapshot,
  ): ColorGradeAuthoredParametersV1 | null;

  /** Fills defaults and clamps. Throws if any value is an animation object. */
  normalize(partial: ColorGradeStaticInputV1): ColorGradeResolvedParametersV1;

  /**
   * Clamps only the fields present, leaving the rest of a grade untouched.
   * Unknown keys are rejected. Use for partial patches such as presets.
   */
  normalizePatch(
    patch: ColorGradeParameterPatchV1,
  ): Partial<ColorGradeResolvedParametersV1>;

  /** Resolves authored animation at a source-media time, then normalizes. */
  resolve(
    authored: ColorGradeAuthoredParametersV1,
    options: { readonly sourceTime: number },
  ): ColorGradeResolvedParametersV1;

  /**
   * Builds an input for `timeline.transaction().upsertTransform()`. Pass the
   * existing `transformId` when updating a grade; omitting it creates a second
   * grade transform on the clip rather than replacing the first.
   */
  toTransformInput(
    grade: ColorGradeAuthoredParametersV1 | ColorGradeResolvedParametersV1,
    options?: {
      readonly transformId?: string;
      readonly isEnabled?: boolean;
    },
  ): ExtensionTimelineTransformInput;
}

/**
 * The host's own color implementation. Calculations performed here match the
 * renderer because they run the same code, not a reimplementation of it.
 *
 * A grade's creative LUT is referenced by asset ID only. To evaluate one with
 * full renderer parity, load the bytes out of band first:
 *
 * ```ts
 * const grade = api.color.grade.resolve(authored, { sourceTime });
 * const blob = grade.lutAssetId
 *   ? await api.assets.readBlob(grade.lutAssetId)
 *   : null;
 * const lut = blob ? api.color.parseCubeLut(await blob.text()) : null;
 * const evaluator = api.color.createReferenceColorGradeEvaluator(grade, { lut });
 * ```
 *
 * Evaluating without the LUT bytes intentionally applies only the non-LUT
 * portion of the grade.
 */
export interface ExtensionColorApi {
  readonly grade: ExtensionColorGradeApi;

  createReferenceColorGradeEvaluator(
    grade: ColorGradeResolvedParametersV1,
    options?: ColorGradeEvaluatorOptions,
  ): ColorGradeEvaluator;
  /** Grades one premultiplied RGBA pixel. */
  applyReferenceColorGradePixel(
    premultipliedColor: ColorRgba,
    grade: ColorGradeResolvedParametersV1,
    options?: ColorGradeEvaluatorOptions,
  ): ColorRgba;

  /** Bakes a grade into a `.cube` LUT that the fused grade pass can run directly. */
  bakeColorGradeCube(
    grade: ColorGradeResolvedParametersV1,
    options?: {
      readonly size?: number;
      readonly title?: string | null;
      readonly lut?: CubeLut | null;
    },
  ): CubeLut;
  parseCubeLut(text: string): CubeLut;
  serializeCubeLut(lut: CubeLut): string;
  sampleCubeLut(lut: CubeLut, color: ColorRgb): ColorRgb;
  createIdentityCubeLut(size: number): CubeLut;

  readonly COLOR_HISTOGRAM_BIN_COUNT: number;
  buildColorHistograms(pixels: ArrayLike<number>): ColorHistograms;

  createColorCurveSampler(
    points: readonly ColorCurvePoint[],
    cyclic?: boolean,
  ): ColorCurveSampler;
  bakeColorCurveLut(curves: ColorCurveSet, width?: number): Float32Array;

  srgbToLinear(color: ColorRgb): ColorRgb;
  linearToSrgb(color: ColorRgb): ColorRgb;
  whiteBalanceMatrix(temperature: number, tint: number): ColorMatrix3;
  applyMatrix3(matrix: ColorMatrix3, value: ColorRgb): ColorRgb;
}

// === Extension-to-extension composition ===

/** One package this extension declared a dependency on, as resolved. */
export interface ExtensionPeerSnapshot {
  readonly id: string;
  /** The peer's installed version. */
  readonly version: string;
  /** The range this extension declared for it in its manifest. */
  readonly versionRange: string;
  /** Whether the peer is activated right now. */
  readonly isActive: boolean;
  /** Whether the peer published an API through `context.exportApi()`. */
  readonly hasApi: boolean;
}

/**
 * Composition with other packages, through their declared APIs rather than
 * through the timeline model or a trusted global.
 *
 * The relationship is one-directional and declared: you can only reach a
 * package you named in your manifest's `dependencies`, and the host activates
 * those before you, so a dependency's API is already published by the time your
 * `activate` runs. Reaching an undeclared package throws — that is a missing
 * manifest entry, not a state of the editor.
 *
 * Do not cache a peer API across deactivation. The value is whatever the peer's
 * current activation exported; if it is deactivated and reactivated, the object
 * you were holding belongs to a session that is over.
 */
export interface ExtensionPeerApi {
  /** The dependencies this package declared, resolved against what is installed. */
  listDependencies(): readonly ExtensionPeerSnapshot[];
  /**
   * A declared dependency's exported API, or `undefined` when it is inactive or
   * exported nothing. Throws for a package you did not declare.
   */
  getApi(extensionId: string): unknown;
  /** As `getApi`, but throws when no API is available — for a hard dependency. */
  requireApi(extensionId: string): unknown;
}

export interface VloExtensionApi {
  /**
   * Canonical trusted fallback when scoped contributions cannot express the
   * feature. This is version-coupled host access, not a restricted facade.
   */
  readonly trusted: ExtensionTrustedApi;
  readonly runtime: ExtensionHostRuntimeApi;
  readonly backend: ExtensionBackendApi;
  /** Runtime readiness for the model your backend half registered. */
  readonly capabilities: ExtensionCapabilityApi;
  readonly assets: ExtensionAssetApi;
  /** Extension-owned persistent key/value state (local and project scopes). */
  readonly storage: ExtensionStorageApi;
  readonly generation: ExtensionGenerationApi;
  /** Curated color math shared with the renderer, and the V1 grade contract. */
  readonly color: ExtensionColorApi;
  /** Trusted-first scalar, keyframe-segment, and spatial-path contributions. */
  readonly animation: ExtensionAnimationApi;
  readonly payloadProviders: ExtensionPayloadProviderApi;
  /** Trusted-first, executable Pixi entity providers. */
  readonly entityProviders: ExtensionEntityProviderApi;
  readonly timeline: ExtensionTimelineApi;
  /** The transport: playhead, presented frame, running state, and writes. */
  readonly playback: ExtensionPlaybackApi;
  /** The editor selection, readable and settable. */
  readonly selection: ExtensionSelectionApi;
  /** Project identity and lifecycle; the scope `storage.project` follows. */
  readonly project: ExtensionProjectApi;
  /** Audio-bearing model projection and raw-source analysis. */
  readonly audio: ExtensionAudioApi;
  /** Renders: observing them, reading frames, and starting one. */
  readonly export: ExtensionExportApi;
  readonly transitions: ExtensionTransitionApi;
  readonly transformations: ExtensionTransformationApi;
  readonly ui: ExtensionUiApi;
  /** Declared peer packages and the APIs they export. */
  readonly extensions: ExtensionPeerApi;
}

export interface ExtensionIdentity {
  id: string;
  version: string;
}

export interface ExtensionDisposable {
  dispose(): void | Promise<void>;
}

export type ExtensionCleanup = () => void | Promise<void>;
export type ExtensionResource = ExtensionDisposable | ExtensionCleanup;

export type ExtensionDiagnosticLevel = "debug" | "info" | "warning" | "error";
export type ExtensionDiagnosticPhase =
  | "activation"
  | "runtime"
  | "deactivation";

export interface ExtensionDiagnostic {
  extensionId: string;
  level: ExtensionDiagnosticLevel;
  phase: ExtensionDiagnosticPhase;
  message: string;
  timestamp: number;
  detail?: unknown;
}

export interface ExtensionLogger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface ExtensionContext<TApi extends object = VloExtensionApi> {
  readonly extension: Readonly<ExtensionIdentity>;
  readonly sdkVersion: string;
  readonly signal: AbortSignal;
  readonly api: TApi;
  readonly logger: ExtensionLogger;
  onDispose(resource: ExtensionResource): void;
  /**
   * Publishes this package's own API for packages that declare it as a
   * dependency, readable through their `api.extensions.getApi(yourId)`.
   *
   * Callable during `activate` only, and published only if activation
   * succeeds — a package that fails halfway must not leave half an API behind.
   * Calling it twice replaces the value; it is retracted on deactivation.
   *
   * The value crosses no serialisation boundary, so it may hold functions and
   * live objects. It is also a contract you now own: version it, and treat a
   * breaking change to it as a major version of your package.
   */
  exportApi(api: object): void;
}

/**
 * When the host activates a package, declared in its manifest as
 * `activationEvents`. A package that declares none activates at startup, which
 * is what every package did before this existed.
 *
 * - `onStartup` — as soon as the inventory is read.
 * - `onProjectOpen` — when a project opens, or immediately if one already is.
 * - `onExtension:<id>` — after the named package activates. For an optional
 *   companion: use `dependencies` when you cannot work without it, since that
 *   also fixes the ordering and checks the version.
 *
 * A package another one depends on activates when that dependent does,
 * whatever its own events say.
 */
export type ExtensionActivationEvent =
  | "onStartup"
  | "onProjectOpen"
  | `onExtension:${string}`;

export interface ExtensionModule<TApi extends object = VloExtensionApi> {
  activate(
    context: ExtensionContext<TApi>,
  ): ExtensionLifecycleResult | Promise<ExtensionLifecycleResult>;
}

export type ExtensionActivationStatus =
  | "inactive"
  | "activating"
  | "active"
  | "deactivating"
  | "failed";

export interface ExtensionActivationState extends ExtensionIdentity {
  status: ExtensionActivationStatus;
  error?: unknown;
}

export interface ExtensionApiScope {
  readonly extension: Readonly<ExtensionIdentity>;
  readonly signal: AbortSignal;
  /** Application/build version shared by host compatibility and API binding. */
  readonly hostVersion?: string | null;
  own<TResource extends ExtensionResource>(resource: TResource): TResource;
  report(
    level: ExtensionDiagnosticLevel,
    message: string,
    detail?: unknown,
  ): void;
}

export type ExtensionApiFactory<TApi extends object> = (
  scope: ExtensionApiScope,
) => TApi;
