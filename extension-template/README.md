# Minimal vlo extension

The official SDK 1 starting point for an extension with a frontend and a
backend entry point.

**The extension SDK is under active development.** Its scoped APIs don't yet
cover everything the editor can do, so building a real extension may mean
reaching into host internals. That can mean looking up live objects through
`context.api.trusted.host`, patching them with `patchProperty(...)`, or
importing deeper backend modules. This is expected and allowed, but these
internals carry no compatibility promise and can change between vlo releases.
If you find yourself patching around an obvious gap, such as a missing hook, a
value you can read but not write, or the same workaround in several places,
please [open an issue](https://github.com/PxTicks/vlo/issues) or send a pull
request so it can become a supported API.

It is also the case that even the supported API may change - development is still in the alpha stage. However, this will be monitored much more closely than unscoped host internals.

**Extensions are not sandboxed.** Any extension that contains code runs with
the same access as vlo itself. Its frontend runs in the editor's page and can
reach any live host object, and its backend runs inside the backend process.
Approving a package in the extension manager is the only gate, so install only
extensions you would trust with your projects and your machine. Approval
applies to the package's exact digest, so a changed package isn't covered by an
earlier approval. The manifest's `capabilities` list is shown to the user but
not enforced. A restricted mode with real isolation is planned but not built.
The declarative contributions mentioned below, such as notices, host filters,
and look packs, are designed to fit it.

| Path                             | Purpose                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `manifest.json`                  | Package ID, version, SDK range, and entry points        |
| `frontend/src/index.ts`          | Frontend `activate(context)` entry                      |
| `backend/extension/__init__.py`  | Backend `create_extension(context)` entry               |
| `vite.config.mjs`                | Build config, including the host-singleton bundle guard |

## Use the template

1. Copy this directory next to `packages/extension-sdk/`, or replace the local
   `@vlo/extension-sdk` dependency with the published package once one exists.
2. Pick an extension ID and set it in `manifest.json`. IDs use lowercase letters,
   numbers, dots, underscores, and hyphens, and start and end with a letter or
   number.
3. Run `npm install`, then `npm run build`. The build type-checks and writes the
   bundle to `frontend/dist/`. Don't edit that directory by hand.
4. Copy the package to `extensions/installed/<manifest-id>/`, or under the root
   set by `VLO_EXTENSIONS_ROOT`. The directory name must match the manifest ID.
5. Approve the package in the extension manager. Approval covers the package's
   exact digest, so rebuild before approving. The backend activates after a
   backend restart, and the frontend on the next page load once the matching
   backend digest reports active.

The template's `/status` route is served at
`/app/extensions/<extension-id>/api/status`. Remove it when you replace the
template with a real backend.

## How to build on SDK 1

Start with the scoped contribution and transaction APIs. If they can't express
the feature, fall back to `context.api.trusted.host`, browser APIs, raw
registries, or deeper Python imports. That fallback is tied to the host
version, so pin a narrow `vlo` range in `manifest.json` and report the gap as
described above.

For task-by-task guidance beyond this summary, see the
[extension-development skill](../extensions/extension-development/SKILL.md) and
its references.

### Frontend runtime and bundling

- `@vlo/extension-sdk` is type-only. Import it with `import type`. Everything you
  call at runtime comes from the activation `context`.
- React, React DOM, MUI/emotion, Zustand, and Pixi are host singletons. Use the
  injected copies: `context.api.runtime.react`, `.pixi`, `.mui`, `.panelUi` (the
  complete host panel-control barrel, including its custom-control registry), and
  `.generationUi`.
- The bundle guard in `vite.config.mjs` fails the build if you import a host
  singleton at runtime, or if the bundle has an import it didn't include.
  Type-only imports are erased, so a singleton package can still be a dev
  dependency for editor typings.
- The guard catches common mistakes but is not a security boundary. A hand-written
  build can bypass it and then fail at activation or load a second copy of a
  singleton. The host doesn't validate bundles yet.
- Reach other live frontend internals through `context.api.trusted.host`, not
  runtime imports from `frontend/src/...`. Production can't resolve source paths,
  and bundling them creates detached copies of module state.

### UI

- Every extension React surface shares one host mount and error boundary.
- Use `context.api.ui.registerComponent(...)` for content in a declared slot such
  as `generation.inputs.after`. Registering against a slot the host hasn't
  declared throws.
- Use `registerModal(...)` for larger flows and open it by local ID with
  `openModal(...)`. The host owns placement, close behaviour, and lifecycle.
  Modals can't receive library drags.
- Use `registerView(...)` with `kind: "trusted-view"` for persistent tools. Views
  go in a shell region: `left-sidebar`, `right-sidebar`, `player-aside`,
  `bottom-dock`, `editor-overlay`, or `projects-page.main`. A view mounts on first
  use and then stays mounted while hidden. It receives an `active` prop so
  animation loops, cameras, and previews can pause. `openView(localId)` returns
  `false` if the user has hidden the view.
- For simple UI, prefer native notices (`registerNotice`) and declarative host
  filters. They are also the parts most likely to carry over to a restricted
  mode.

### Generation panel

- Read the mounted workflow through `context.api.generation`. Use `listInputs()`
  for the panel's input slots, and `getSession()` with `subscribe()` and
  `getRevision()` for the node and widget catalogue.
- Put input and widget writes in one labelled, synchronous
  `generation.transaction(...)`. The host validates the whole batch and applies
  it as a single panel update.
- To change a widget that has no panel control, register a submission
  contributor that returns `bypass-nodes` or `set-widget` effects. The host
  validates them and stores them in the queued plan. See
  `extension-fixtures/lora-policy`.
- The API addresses workflow nodes, widgets, and inputs, never ComfyUI DOM nodes.
- A workflow can host an extension-owned section. Register the body with
  `context.api.generation.ui.registerSection(...)` and reference it from a
  `sections` entry in the workflow's `.rules.json`. `extension_id` is your
  manifest ID and `contribution_id` is the section's local ID. The rule owns
  the title, order, default-open state, and a finite-JSON `config`. A collapsed
  section stays mounted with `active: false`. See
  `extension-fixtures/layout-prompt`.

  ```json
  {
    "sections": [
      {
        "id": "motion_path",
        "title": "Motion path",
        "order": 2,
        "extension": {
          "extension_id": "example.path-tools",
          "contribution_id": "canvas",
          "config": { "stroke": "#22d3ee" }
        }
      }
    ]
  }
  ```

### Rendering and animation

- Pixi factories return `{ object, update, destroy? }`. The host attaches
  `object`, calls `update` with resolved parameters, detaches it, and destroys
  it. Use `destroy` only for extra resources you created. Transformation filters
  can be any Pixi filter, including custom GLSL/WGSL shaders. If you bypass this
  lifecycle and touch the renderer or stage directly, you own teardown and export
  parity.
- **Planned change:** as effects move to a node graph, extension filters stay
  opaque steps. They
  won't be fused into a single shader with host effects, and no public shader
  API is planned yet. A filter that keeps history between frames
  (`rendering.timeDependency: "history"`) may need a new declaration of the GPU
  memory it holds before it can run on the new render path. Until then it
  stays on the current path.
- `context.api.entityProviders.register(...)` adds custom timeline entities. A
  provider supplies a versioned payload codec, a Pixi factory (`Container`,
  `Graphics`, `Sprite`, …), and optionally a React inspector. The host treats the
  result like built-in content, so transformations, filters, masks, selection
  bounds, stills, and export all work unchanged. Create and update entities with
  `context.api.timeline.transaction(...)`.
- Entity providers can implement `getRenderSignature` to reuse the cached
  texture while the signature is unchanged. The signature must cover every pixel
  input the provider owns, such as frame time or asset hashes. Leave it out for
  animated or externally mutable content, and the host renders every frame.
- The entity render context's `renderer` is the host's live Pixi `Renderer`
  instance, not a restricted facade. Changes to it affect the whole editor.
  It is a different object from `context.api.runtime.pixi`, which is the Pixi
  module namespace you construct objects from.
- `context.api.animation` has three separate registries: `scalarSources`
  (procedural scalar functions), `interpolations` (keyframe segment curves), and
  `spatialPaths` (2D geometry). Each definition has a label, versioned default
  data, validate/migrate/compile functions, and optional remap or reverse and
  editor hooks. Spatial paths can add a Pixi overlay using the same
  `{ object, update, destroy? }` lifecycle. A scalar source used as a speed
  factor must provide a two-way `timeMap`.
- `context.api.transformations.presets.register(...)` adds static presets. API
  version 1 supports only partial `ColorGradeFilter` patches: omitted fields
  stay unchanged, and animated values and `lutAssetId` are rejected. Use
  `context.api.color.grade.filterName` as the target.

### Assets and timeline

- `context.api.assets.ingest(...)` copies bytes into the active project and
  returns the asset, reusing an existing one on a hash match. Use it for
  generated files, and never store extension package paths in timeline data.
- LUT-only packages don't need code. Use a declarative look pack instead; see
  [packaging and testing](../extensions/extension-development/references/packaging-and-testing.md)
  and `extension-fixtures/look-pack/`.
- For tracking-style features, `context.api.timeline` converts between clip and
  source time (`sourceFrameToTicks`, `clipProgressToSourceTicks`,
  `sourceTicksToClipProgress`) and maps source pixels to centred project
  coordinates (`sourcePointToProject`). Show a non-committing preview first, then
  write everything in one labelled `timeline.transaction(...)`.
- `upsertTransform` replaces a transform wholesale. Updating an existing filter
  drops fields the transform input can't carry, such as its effect mask.

> **Planned changes.** Effects and masks are moving to a node graph, which will
> change two parts of the timeline API:
>
> - **Filters become graph nodes.** A clip's `transformations` from `listClips()`
>   becomes a read-only view of its filter nodes in render order. Once branching
>   graphs are enabled, that view can't show how nodes connect, and list writes
>   that would flatten a branch are rejected. Don't assume `transformations` is
>   the clip's complete, linear filter chain. Graph-shaped access would come as
>   a separate, versioned API.
> - **Masks become shareable.** A mask's content (shape, points, assets,
>   inversion, and its own transforms) moves into a library entity that several
>   clips can use. Mode and active range stay per clip. Once sharing is
>   enabled, editing a mask's parameters through one clip changes it on every
>   clip that uses it. Mask IDs from `listClipMasks()` stay valid.

### Backend

- The backend runs as in-process Python with the host's full access.
  `services.extensions` is the supported import surface. You may import deeper
  modules or patch process objects, but those have no compatibility guarantee: declare a narrow `vlo`
  version range in `manifest.json` and undo patches in `shutdown`.
- Keep `create_extension` and any readiness or validation callbacks fast. Put
  model loading and other long work in a `BackendJobDefinition`. Jobs get
  scoped input artifacts, output-artifact creation, progress reporting,
  cancellation, and diagnostics. Declare readiness and validate both input and
  output.
- A job timeout marks the job as finished but can't stop a running synchronous
  Python thread. Long-running jobs should call `context.raise_if_cancelled()`
  regularly.
- The backend can't open files the user picked in the browser. On the frontend,
  read them with `context.api.assets.readBlob(...)`, upload them with
  `context.api.backend.uploadArtifact(...)`, then use `submitJob` and
  `waitForJob`. `backend.call(...)` is the raw-route escape hatch.
- Only the package's `backend/` directory is staged for the backend, so keep
  Python resources inside it.
