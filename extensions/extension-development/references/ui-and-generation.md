# UI and generation tools

Use this reference for trusted React contributions, modals, persistent workspaces,
HTML/SVG/WebGL canvases, and ComfyUI workflow-input integration.

## Use host-native React and controls

Obtain React from `context.api.runtime.react`, selected MUI controls from
`runtime.mui`, and native panel controls from `runtime.panelUi`. Use type-only
package imports to improve authoring types, but do not bundle runtime copies of the
host singleton families.

All trusted UI runs with main-page authority. Host error boundaries contain ordinary
render failures and report diagnostics; they are not a security boundary.

`runtime.panelUi` is the complete host barrel, including its raw custom-control
registry. It is typed as an open map of `unknown` and is explicitly
version-coupled: you assert every component and prop shape locally, and a host
change can break you without a compiler error. Treat it as the escape hatch.

Narrower runtimes are typed and are the better path where one exists —
`runtime.generationUi` carries the generation panel's own surfaces with a
declared contract. Trusted code may also use the DOM and browser APIs directly.
When no slot, zone, or workspace fits without losing important functionality,
use raw panel/DOM integration with explicit `onDispose()` cleanup and document
the VLO coupling.

## Select a UI contribution

Register through `context.api.ui`:

- `registerNotice` for host-rendered declarative information;
- `registerComponent` for arbitrary trusted React in a declared slot;
- `registerModal` for a host-owned MUI dialog with extension-owned contents;
- `registerView` for a persistent extension tab in a host-owned shell region;
- `registerPanelTakeover` for a body that replaces one panel's own, in its
  frame.

Fixed slots, each mounted at one hand-placed point:

- `transformation-panel.before`;
- `generation.toolbar`;
- `generation.inputs.after`;
- `timeline.toolbar`.

**Anchors** are slots named after a structural element rather than enumerated,
because the element belongs to the mounted workflow and its id is not knowable
when you activate:

- `generation.section.<sectionId>.before`;
- `generation.section.<sectionId>.after`.

So `generation.section.prompts.after` puts a control directly under the prompt
box, in every workflow that has one. Section ids come from workflow rules; text
inputs land in `prompts` and media inputs in `inputs` unless the rules say
otherwise, and a section whose id is not a safe slot segment gets no anchor.

The host still owns which anchors exist and what they are called — a family
declares the *shape*, not an open namespace — so registering against anything
it has not declared throws. Prefer asking for a new anchor when a location is
generally useful; use trusted raw DOM or host access for one-off, exploratory,
or build-coupled integrations.

### Show a contribution only sometimes

`registerComponent` takes a `when` clause over host context keys, evaluated by
the host: a contribution whose clause is false is never mounted.

Prefer it to mounting and returning `null`. The slot renders a wrapper around
whatever it holds, so a component that renders nothing still leaves a padded,
empty box where it sits.

Conditions the key vocabulary cannot express — "is the mounted workflow one I
serve?" — are not context keys. Derive the answer yourself and publish it as
one with `commands.setContextKey`, then read it in `when`; that is what keeps
the wrapper from mounting at all.

```ts
// Republished only when the answer changes; the session fires constantly.
api.ui.commands.setContextKey("supported", isMine(api.generation.getSession()));
api.ui.registerComponent({
  id: "compose-button",
  apiVersion: 1,
  slot: "generation.section.prompts.after",
  kind: "trusted-react",
  when: { key: `extension.${context.extension.id}.supported` },
  component: ComposeButton,
});
```

Use `openModal(localId, input?)` to open only the caller's modal. Keep input and
result finite JSON. Handle an `undefined` result as cancellation or disposal.
Omitted modal size defaults to `medium`.

**A modal cannot accept library drags.** The modal host is app-wide — it has to
work on the projects page, before any project is open — so it mounts *outside*
the editor's drag context. `runtime.panelUi`'s `AssetDropSlot` and
`AssetBatchDropSlot` use the host's own dnd-kit instance, which means an
extension needs no drag library, but also that a drop slot inside a modal
**never fires, and produces no error to debug.** View regions mount inside that
context and work; for a non-blocking workspace that takes drags, use
`editor-overlay`.

Register `kind: "trusted-view"` at one of six `defaultRegion` values:

- `"right-sidebar"` — clip and generation editors;
- `"left-sidebar"` — an input-source tab alongside Assets, Text, Composite,
  Effects, and Transitions;
- `"projects-page.main"` — a tool available before a project opens;
- `"player-aside"` — a column beside the player canvas, for tools that have to
  sit next to the picture. It takes no space until something registers there;
- `"bottom-dock"` — the dock between the player and the timeline, where the
  video scopes live;
- `"editor-overlay"` — a draggable, resizable panel floating over the editor,
  for a workspace that must stay open while the user works in the surface
  behind it. Like the bottom dock it starts closed.

Use `openView(localId)` to select it. Views mount lazily on first selection, then
remain mounted to preserve state. Observe the `active` prop and pause animation
loops, camera capture, polling, or expensive previews while hidden. User layout
choices win: `openView` returns `false` when the user has hidden the view.

The bottom dock is the one region that starts **closed** — an empty selection is
its closed state, unlike the sidebars, which always show something. A view you
register there is not visible until `openView` or the user opens the dock, so do
not treat registration as "on screen".

### Let the user move your view

`defaultRegion` says where a view is *born*. Add `allowedRegions` and the user
can move it afterwards, from "Manage panels":

```ts
api.ui.registerView({
  id: "subjects",
  apiVersion: 1,
  kind: "trusted-view",
  title: "Subjects",
  defaultRegion: "right-sidebar",
  allowedRegions: ["right-sidebar", "left-sidebar", "bottom-dock"],
  component: SubjectsView,
});
```

Only the four **docked** regions can take part — `left-sidebar`,
`right-sidebar`, `player-aside`, `bottom-dock`. They are the ones the layout
kernel arranges, persists and lists.

Opting in changes how the view is mounted. A portable panel is rendered once
from a fixed position and its DOM container is adopted by whichever region
shows it, so a move preserves React state, effects, subscriptions and canvas
contents rather than remounting. Two consequences for your code:

- **`region` changes underneath you.** Read it from props each render; never
  cache the region you registered with.
- **Providers come from the host, not the region.** The panel is rendered
  through a portal, so React context reaches it from where the portable host
  sits — which is inside the editor's `DndContext`. Drop slots keep working
  after a move.

The placement is remembered per view id and survives disable/enable. If a later
version of your extension narrows `allowedRegions`, a stored placement outside
the new list is discarded and the view falls back to `defaultRegion`.

## Gotchas

Failure modes that produce no error, or an error a long way from its cause.
Each is a real trap that has cost time.

**A drop slot inside a modal never fires.** `ui.registerModal` mounts app-wide,
because it has to work on the projects page before a project is open — which is
*outside* the editor's `DndContext`. A `runtime.panelUi` drop slot in a modal
silently never receives anything, with nothing logged. Use a view region: they
all mount inside that context, and `editor-overlay` gives you a floating,
non-blocking panel if that is the modal shape you wanted.

**`allowedRegions` throws if it names anything but a dock region.**
Registration is validated, and an invalid list throws out of `registerView` —
which fails activation, so the whole extension does not load. The four
rejections are:

| What you wrote | Why it throws |
| --- | --- |
| a region outside the four dock regions | nothing can host a moved panel there |
| `allowedRegions` with `defaultRegion: "editor-overlay"` or `"projects-page.main"` | the default itself is not a dock region, so the view can never be portable |
| a list omitting `defaultRegion` | a move menu could strand the panel outside its own list |
| `[]` | omit the field instead; an empty list is a mistake, not "no moves" |

The second is the easy one to hit: `editor-overlay` reads like just another
region, and adding `allowedRegions` to a floating panel looks harmless. It is
not — a floating panel has no dock to be moved between. Omit `allowedRegions`
entirely for `editor-overlay` and `projects-page.main` views.

**A view registered in the bottom dock or the overlay is not on screen.** Both
start closed. Registration is not visibility; call `openView`, and respect a
`false` return, which means the user hid it.

**`openView` takes no input.** Unlike `openModal`, it cannot carry a payload.
If one view opens another on a particular subject, keep that selection in your
own module state and have the opened view read it.

## Contribute a video scope

`ui.scopes.register({ id, apiVersion: 1, kind: "trusted-scope", label, width,
height, order?, render })` adds a tab to the bottom dock beside the host's
waveform, parade, vectorscope, and histogram — they go through the same registry,
so ordering is one comparison over one table rather than host-first.

`render({ context, width, height, frame })` receives a host-owned 2D context,
already sized and cleared, and `frame.pixels`: **premultiplied** RGBA bytes of
the composited picture. Undo alpha before measuring luma. The buffer belongs to
the host and is valid only for that call — copy anything you need to keep. State
the resolution you draw at through `width`/`height` (16 to 2048 each); the dock
scales the result to the available width.

`render` runs on a sampling loop several times a second while the dock is open.
Keep it synchronous and allocation-light. A throw is caught and reported once,
then suppressed until the scope draws again, so check your diagnostics if a
scope goes blank rather than expecting a crash.

## Report long-running work

`ui.notifications` is where work that takes longer than a click reports to.

- `toast({ message, tone?, durationMs? })` for something that happened.
  `durationMs: 0` keeps it until dismissed; the default auto-dismisses.
- `task({ title, message?, progress?, onCancel? })` for something that *is*
  happening. `update({ message?, progress?, tone? })` leaves omitted fields
  alone, and `progress: null` goes back to indeterminate. Finish with
  `settle({ message?, tone? })`, which replaces the entry with a toast, or
  `settle()` to end it silently.

Supplying `onCancel` shows a cancel affordance. The host calls it and **leaves
the task in place**: cancelling asks your work to stop, and only your work knows
when it has — settle the task once it actually does.

Everything you post is removed when you deactivate, so a package that dies
mid-task cannot leave a spinner behind. One extension may hold at most 16 live
entries at a time; exceeding that throws rather than burying the editor.

Frontend activation happens before a project opens. Views, commands, menus,
catalogues, backend jobs, and local storage are available there, while
`storage.project` is `null`; timeline and asset operations fail closed. Gate
editor-dependent commands and views with the `project.open` context key.

Render ordinary HTML5 canvas, SVG, WebGL, or browser controls inside a trusted slot,
modal, or view. Keep host navigation, dialog close semantics, and region placement
outside the extension component.

## Contribute an exclusive player-canvas tool

Register a tool with `ui.canvasTools.register`. The returned local `command` can be
used directly in a keybinding request; the host toolbar projects the same command.
Only one tool is active. While it is active, the host suspends canvas selection,
mask editing, and gizmos; Escape and the Select toolbar item restore host behaviour.

`activate(session)` receives a host-owned transient Pixi `overlay`, coordinate
conversion helpers, and `targetClipId`, captured before host selection pauses. Draw
only previews and cursors in the overlay; the host clears it on deactivation. Handle
normalised `down`/`move`/`up`/`cancel` events in `onPointer`, and commit durable work
through asset ingestion plus timeline entity/mask transactions. Always tolerate a
null target clip, cancellation, contribution disposal, and asynchronous ingest
failure. Do not attach independent listeners to the host stage unless using the
explicit trusted escape hatch.

## Commands and keybindings

The host keeps one command table; menus, keybindings, and the canvas toolbar are
projections of it. Register with
`ui.commands.register({ id, apiVersion: 1, title, icon?, when?, run })` using a
local ID — the host qualifies it as `extensionId/id`. `run(invocation)` receives
`{ source, subject? }`, where `subject` is the detached JSON subject of the
invoking surface.

Gate enablement declaratively with `when` over host context keys rather than
checking inside `run`, so every surface renders the command consistently. Current
host keys: `project.open`, `editor.open`, `focus.region`, `playback.playing`,
`selection.clipCount`, `selection.clipType`, `selection.transitionSelected`,
`timeline.canUndo`, `timeline.canRedo`, `timeline.canPaste`. Read one directly
with `ui.commands.getContextKey(key)`; an unknown key returns `undefined`.

Publish state of your own with `ui.commands.setContextKey(key, value)`. The host
qualifies it as `extension.<yourId>.<key>` and returns that name, which is what
any `when` clause must use — yours or another package's. Host keys stay
host-owned: you can add to the editor's vocabulary, not redefine `project.open`.
Values are finite JSON, `undefined` clears a key, and every key you wrote is
cleared when you deactivate, so a stale state cannot outlive the package that
meant it. This is the smallest way two packages compose: one publishes a state,
the other gates a command on it, and neither touches the timeline model.

Request a chord with
`ui.commands.registerKeybinding({ id, apiVersion: 1, chord, command, regions? })`.
The command must already be registered. `"Mod"` is Ctrl, or Cmd on macOS. A chord
that collides with an existing binding — including chords the host reserves for
its own shortcuts — registers *inactive* with a diagnostic rather than failing
activation, so check your diagnostics if a shortcut appears dead. Omit `regions`
for a global binding; otherwise name the editor focus regions it applies in.

`ui.commands.execute(localId, subject?)` invokes one of your own commands and
resolves `true` when it ran, `false` when its `when` clause was false — a
disabled command is a state of the editor, not an error, so branch on the
result rather than assuming it ran. It throws for an unregistered ID.

Host commands are an authority surface: they execute only if the host opted
that specific command in, and none do today. Contribute a menu placement and
let the user invoke it.

## Option catalogues

A host catalogue is a named option list behind a host dropdown. Discover them with
`ui.catalogues.listCatalogues()`, which returns each `id` with a
documentation-grade `valueSchema`; the host's own validation is authoritative and
rejects a value that does not fit. Contribute with
`ui.catalogues.addOption({ id, apiVersion: 1, catalogueId, label, value, order?,
when? })` — a local `id`, qualified by the host — and read the currently visible
options of a catalogue, host and extension alike, with `ui.catalogues.list(id)`.

Values are cloned and frozen on registration, and `when` gates visibility over
context keys. A catalogue is not a general data bus: contribute only values its
schema describes.

## Context/action menus

Register a command first, then place it with
`ui.menus.addItem({ id, apiVersion: 1, menuId, kind: "command", command, group,
order?, when? })`. Discover current menu IDs and their documentation-grade subject
schemas through `ui.menus.listMenus()`; this includes editor menus and the
pre-project `projects.item.context` menu. The host renders command title/icon and
enablement, and invocation receives the menu's schema-validated subject as detached
JSON. Structured `when` conditions can inspect host context keys or subject paths;
menu placements do not carry visibility or selection callbacks.

## Per-clip timeline overlays

`context.api.timeline.registerClipOverlay({ id, apiVersion: 1, kind: "trusted-overlay",
useItems })` adds badges, markers, or draggable handles to every timeline clip.
`useItems({ clip, isSelected })` is a React hook run on the timeline's hot render
path — obey the Rules of Hooks and keep it cheap. Each item declares `content` (trusted
React), a `placement` (`endpoint` or source-time), optional `onClick`/`onContextMenu`,
and optional `drag` handlers that receive source/visual/presentation tick maths. `clip`
is a detached snapshot; the registration is owner-scoped and removed on deactivation.

## Choose the generation rung before writing code

Three rungs, in the order to try them:

1. **A workflow rule sidecar.** Policy for *one* workflow is a `.rules.json`
   next to it. No extension, no code, no lifecycle to get wrong.
2. **A trusted extension: reactive UI plus submission effects.** Custom policy
   the user drives — read the session, render a control in a generation slot,
   write the widgets the panel exposes, and contribute graph effects for the
   rest. `extension-fixtures/lora-policy/` is the worked example, from
   discovery through the queued plan.
3. **A rule provider or backend stage.** Neither exists. Each is gated on a
   named consumer and its own design (see
   `docs/generation-extension-surface-plan.md` §5); do not approximate one by
   writing on a timer or mutating state at submission.

## Read and write generation inputs

Call `context.api.generation.listInputs()` during user-driven UI work to obtain
detached active workflow inputs. Do not assume a fixed ComfyUI node ID; select by
returned ID and present labels when multiple text inputs exist.

Commit text changes with one synchronous labelled
`context.api.generation.transaction(label, callback)` and `setTextInput`. Inspect
the result:

- `unavailable` means the generation panel adapter is not mounted or activation
  ended;
- missing or non-text inputs fail without partial writes;
- asynchronous callbacks are invalid.

A modal can outlive the generation tab. On failure, retain user work, show the result
message, and allow retry or cancellation rather than throwing or closing blindly.

Keep vendor-specific prompt dialects in extensions. Prefer a versioned internal
layout model and translate it to the chosen model's JSON only at commit time.

## Read the mounted workflow reactively

`generation.getSession()` returns a detached snapshot of the mounted workflow, or
`null` when no generation panel is mounted. It carries the workflow's identity
(`sourceId`, `instanceId`, `revision`, `fingerprint`, `mode`), a `status` of
`loading`/`ready`/`error`, the panel inputs, `canSubmit`, `busy`, and the node
catalogue: each node's `id`, `classType`, `title`, `mode`, and widgets.

A panel input carries `value` for a **text input only**; a media input's
contents are in `media`, and the batch ceiling in `repeatable`. See "Read what
is attached to a media input" below — a media slot is not "present but empty"
just because `value` is absent.

`instanceId` is `null` until the ComfyUI bridge reports identity, and a node `id`
is an execution ID — `<id>` at the root, `<instanceId>:<innerId>` inside a
subgraph instance. Match nodes by `classType` and widget metadata. There are no
inputs, ports, or links in the snapshot, so you cannot tell how a node is wired;
do not infer it from ordering or titles.

Each widget reports `valueType`, `value`, `defaultValue`, `options`, `min`,
`max`, `step`, `linked`, and `editable`. Only an `editable` widget has a panel
control behind it and can be written with `setWidget`; the rest are readable
metadata. For an editable widget the published constraints are the ones a write
is judged against, and `null` options or bounds mean unrestricted, not unknown.
Where more than one control is bound to the same widget the constraints are
their union — the host accepts a value if any of those controls accepts it — so
a published range can be wider than any single control's.

Snapshots are bounded in every dimension, including totals across the whole
snapshot. A very large catalogue is truncated, an oversized value is published
as `null`, and an oversized prompt input is published without its `value`
rather than shortened; each comes with a diagnostic saying so. Do not treat the
absence of a node or an option as proof the workflow lacks it without checking
your diagnostics.

`subscribe(listener)` is payload-free and pairs with `getRevision()`, so the pair
goes straight into `useSyncExternalStore`. The same snapshot object is returned
until something changes, and the subscription is removed on deactivation:

```tsx
function useGenerationSession(api: ExtensionGenerationApi) {
  return React.useSyncExternalStore(api.subscribe, api.getSession);
}

function LoaderPicker({ api }: { api: ExtensionGenerationApi }) {
  const session = useGenerationSession(api);
  const loaders = React.useMemo(
    () =>
      (session?.workflow.nodes ?? []).filter(
        (node) => node.classType === "LoraLoader",
      ),
    [session?.workflow],
  );
  if (!session) return null;
  // …render `loaders`, and write with api.transaction(...)
}
```

### Where that component goes

Three placements, and the difference is *who decides where it appears*:

- **`api.generation.ui.registerSection()`** — the body of a panel section the
  *workflow* selects. The workflow's rules sidecar carries the placement half
  (`extension_section` with your `extension_id`, a `contribution_id` matching
  the section's `id`, and an optional `config` object your component receives).
  Use this when a particular workflow should decide whether and where your UI
  shows up. It costs a rules edit per workflow, and a workflow naming a
  provider that is not active renders a warning in the panel — so it is the
  wrong choice for an optional package.
- **`api.ui.registerComponent()` at an anchor** such as
  `generation.section.prompts.after` — the extension decides, and can decide
  *conditionally*: no rules edit, every workflow that has that section, and a
  `when` clause or a derived context key to narrow it. This is usually what
  you want for something that applies to a family of workflows rather than to
  one named file.
- **`api.ui.registerComponent()` at a fixed slot** such as
  `generation.inputs.after` — the same, at one of the hand-placed points. Use
  it when the location is the panel as a whole rather than a section of it.

All close over `context.api.generation` for reads and writes.

```ts
context.api.generation.ui.registerSection({
  id: "loader-picker",
  apiVersion: 1,
  kind: "trusted-react",
  component: LoaderPicker,
});
```

### Accepting library drags

`runtime.panelUi` exports `AssetDropSlot` and `AssetBatchDropSlot`, which use
the *host's own* dnd-kit instance. An extension needs no drag library of its
own — but it does need to be mounted inside the editor's drag context:

- **View regions are inside it.** `left-sidebar`, `right-sidebar`,
  `player-aside`, `bottom-dock`, and `editor-overlay` all work.
- **Modals are not.** `ui.registerModal` mounts app-wide, because it has to
  work on the projects page before any project is open. A drop slot inside a
  modal **never fires, with no error to debug.**

If you want a non-blocking workspace that stays open over the editor and takes
drags, register a view in `editor-overlay` and open it with `openView`.

Both slots take `disabledActions`: a map from an action the slot offers —
`select`, `externalDrop`, `edit`, `reorder`, `crossInputReorder` — to the
reason it is refused here. A named action is **inert by every route it has**
and renders as refused rather than disappearing. Reach for it when your surface
has the action but cannot perform it in this context; handing the slot a no-op
callback instead looks enabled and does nothing, and omitting the callback
makes the slot look broken.

## Take over a panel

`registerPanelTakeover` replaces one panel's body with your own, inside its
frame — the shape the mask panel uses natively for editing one mask, where a
second registered view would be a second *tab* and a floating panel would not
be in the panel at all.

```ts
const takeover = api.ui.registerPanelTakeover({
  id: "composer-panel",
  apiVersion: 1,
  kind: "trusted-react",
  targetViewId: "host.generate",
  title: "MiniMax prompt",
  onDismissed: () => stopTracking(),
});
if (!api.ui.openPanelTakeover("composer-panel").ok) openFallbackWindow();
```

Four rules worth knowing before you build on it:

- **The host declares the targets.** A panel is one only if its registration
  opted in; `listPanelTakeoverTargets()` enumerates them.
- **Register regardless of what that list says.** Panels are declared by the
  modules that render them and the editor loads lazily, so you activate before
  your target exists and the list is empty at that moment. Branch on
  `openPanelTakeover`, which answers for the editor as it is *now* and returns
  `target_unavailable` when the panel is not there.
- **One at a time.** A second takeover of the same panel is refused with
  `target_busy` rather than displacing the first.
- **Dismissal is the host's.** The frame renders the back control; `onDismissed`
  fires when the *user* takes the panel back, never on your own close or
  dispose.

## Edit panel inputs without committing them

A draft is *opened*, not rendered: `api.generation.createInputsDraft` hands you
one owned by your activation, and edits are held until you commit — the panel is
untouched until then. Draw it with `runtime.generationUi.InputsDraftFields`,
which renders the panel's own input fields over your draft.

The split matters: the draft **writes to the panel**, so it needs an owner that
can be disposed, which is why it comes from `api` and not as a component. The
renderer writes nothing of its own, so it lives on `runtime`.

**Open it inside an effect and keep it in state.** A draft subscribes to the
session when it is created and unsubscribes on `dispose`, which makes it an
external resource with a lifecycle — and the app runs under `React.StrictMode`,
which mounts every component setup → cleanup → setup. A draft opened in a
`useMemo` (or a `useState` initializer) is disposed by that first cleanup and
never replaced, because the memo does not re-run. The symptom is silent and
looks nothing like a lifecycle bug: `getState()` returns the inert reading for
the life of the view, so the fields render an empty box, `stage` does nothing,
`canCommit` stays `false` — and `error` is `null`, so nothing anywhere reports
a problem. The host's own `useGenerationInputsDraft` is written this way for
the same reason.

```ts
// Held in state, because that is what publishes the live draft to the render.
const [draft, setDraft] = hooks.useState<ExtensionGenerationInputsDraft | null>(
  null,
);
// Keyed by what it addresses: there is no `retarget`, so a changed address
// means a new draft. A constant key opens one draft for the view's lifetime.
const addressKey = `${promptInputId},${startFrameInputId}|9:length`;
hooks.useEffect(() => {
  const opened = api.generation.createInputsDraft({
    inputIds: [promptInputId, startFrameInputId],
    // Optional: node widgets to edit alongside them.
    widgetTargets: [{ nodeId: "9", widget: "length" }],
  });
  setDraft(opened);
  return () => {
    opened?.dispose();
    // Only if it is still the current one — the next setup may already have
    // published its replacement.
    setDraft((current) => (current === opened ? null : current));
  };
}, [addressKey]);
// `getState` is identity-stable between changes, so it drives a store hook.
hooks.useSyncExternalStore(
  (onChange) => draft?.subscribe(onChange) ?? (() => undefined),
  () => draft?.getState() ?? null,
);

const state = draft?.getState();
return h(
  Box,
  null,
  draft ? h(api.runtime.generationUi.InputsDraftFields, { controller: draft }) : null,
  h(Button, {
    disabled: !state?.canCommit,
    onClick: () =>
      // Staged edits and your own writes, in one transaction.
      draft?.commit("Compose prompt", (tx) =>
        tx.setTextInput(promptInputId, composedText),
      ),
  }, "Commit"),
);
```

- `createInputsDraft` returns `null` once your activation has ended.
- Call your hooks **before** any early return. A workflow that stops being
  supported while your view is mounted must not change the hook count.
- An empty editor with no error is the disposed-draft symptom above, not a
  targeting mistake. Read the controller the fields were handed: `inputs: []`
  *and* `widgetValues` empty *and* `error: null` together is the inert reading
  of a dead draft. A genuinely mis-addressed draft still resolves whichever
  half did match.
- `getState().inputs` is the staged projection, described exactly as the session
  describes a live input; `widgetValues` is keyed `nodeId:param`.
- `hasDraftChanges` is "I hold edits"; `hasConflict` is "the panel moved under
  something I hold"; `canCommit` is "a transaction may be attempted" — true with
  nothing staged, because your `additionalWrites` may still have something to
  say.
- The draft clears only after a successful transaction, so a failed commit
  leaves your edits in place rather than showing a panel that never took them.
- `stage(op)` edits it programmatically — `setText`, `attachAsset`,
  `replaceMedia`, `removeMedia`, `moveMedia`, `setMediaOption`, `setWidget` — so
  you can preview a preset without a rendered field. `attachAsset` appends;
  `replaceMedia` overwrites the position `at`.

**Only what the transaction can express can be staged.** Timeline capture,
external file drops and media editing each start real work — a render, an
ingest — and produce values no id can name until they finish, so the editor
shows them refused with a reason. Expect the same of anything you add: if there
is no transaction command for it, it cannot be held.

## Read what is attached to a media input

`ExtensionGenerationInputSnapshot.value` is **text inputs only**. A media
input's contents are in `media`, an ordered list of the slots that are actually
filled:

```ts
const references = api
  .getSession()
  ?.inputs.find((input) => input.id === "10:images")?.media ?? [];

for (const item of references) {
  // item.ordinal is the delivery position — the number a reference tag counts.
  // Never infer order from item.slotId.
  console.log(item.ordinal, item.displayName, item.mediaType);
}
```

Four things about this list decide whether your code is correct:

- **`ordinal` counts filled slots**, matching what the backend's batch loader
  and ComfyUI's `Autogrow` expansion do. It is not the slot index and not the
  array index of some wider fixed-size list.
- **`mediaType` is what the slot delivers, not what the asset is.** A video
  attached to an *audio* input contributes its soundtrack and reads as `audio`.
- **`hasAudio` is `boolean | null`, and `null` is not `false`.** It means the
  host cannot know yet: an unrendered timeline selection, or a video ingested
  before the flag was probed. Code that treats `null` as "no soundtrack" will
  be wrong about exactly the cases that matter.
- **A slot being prepared before its value exists is absent from the list, but
  it is not free.** It appears in `reservedSlotIds` instead, and once its value
  lands it moves into `media` with `preparing: true` until it is final. The
  room left in a batch is `repeatable.max - media.length -
  reservedSlotIds.length`, never `max - media.length`.

`repeatable` on the input tells you the batch ceiling and which per-item switch
ids it offers; each item's `options` tells you which of them apply to *that*
item, with their current state.

## Write media inputs

The same labelled transaction carries `attachAsset`, `moveMedia`,
`removeMedia`, and `setMediaOption`. Media commands are **ordered and
cumulative** — each is judged against the state the ones before it left — so
attaching a set of references and switching one on is a single atomic write:

```ts
const result = api.transaction("Attach subject", (t) => {
  t.attachAsset("10:images", firstAssetId, { itemOptions: { audio: true } });
  t.attachAsset("10:images", secondAssetId); // takes the next slot
});
```

Set a new item's switches through `attachAsset`'s `itemOptions`, not a
following `setMediaOption`: the item you just staged has no slot id to name
until the transaction commits, and `setMediaOption` addresses items that
already exist. Positions are ordinals; which *slot* an attach lands in is the
host's to decide, and it skips slots reserved for a value still being produced.

Every media write is validated exactly as the equivalent drag would be: you
cannot place an asset a user could not drag into the same slot. Attaching a
silent video to an audio input fails with `asset_type_rejected`, just as the
drop target would refuse it. The refusals worth branching on are
`asset_not_found`, `asset_type_rejected`, `batch_full`,
`ordinal_out_of_range`, `input_not_repeatable`, `media_not_found`,
`option_not_available`, and `input_busy`.

`input_busy` is the one worth handling rather than reporting. While an input
has `reservedSlotIds`, any write that **repacks** the batch — `moveMedia`,
`removeMedia`, or an `attachAsset` with an `at` that is not the end — is
refused. Repacking rewrites slots densely, which would move an existing item
into the slot a pending render is about to write to, and the host cannot cancel
that render. Appending is always allowed. The condition clears itself when the
media lands and the session republishes, so the retry is simply: wait for
`reservedSlotIds` to empty.

`changed` in the result means something actually moved. A reorder onto the
position an item already holds, or a switch written to the value it already
has, validates but reports `changed: false` — the same rule text and widget
writes follow, so it is safe to gate follow-up work on.

## Claim a text input

An extension that composes a prompt from structured parts needs the box it
writes to stop taking free edits behind its back:

```ts
const claimed = api.generation.claimTextInput("6:text", {
  reason: "The prompt composer is writing this prompt.",
  onRevoked: () => markOutOfSync(),
});
```

While claimed, the panel renders that box read-only with your `reason` and an
"Edit anyway" control. If the user takes it back, the claim is gone and
`onRevoked` fires — **stop tracking the text there rather than overwriting what
the user then types.** One claim per input: a second fails with
`input_already_claimed` rather than displacing the first. Dispose the
registration to release it; claims die with the activation either way.

## Write a workflow widget

`setWidget({ nodeId, widget }, value)` sits alongside `setTextInput` in the same
labelled transaction and follows the same rule: every command validates before
any applies. Values are finite JSON and bounded, and the host validates them
against the widget's own type, enum, and range. Three refusals are worth
branching on:

- `widget_not_found` — the mounted workflow has no such widget; re-read the
  session rather than retrying;
- `widget_not_editable` — the widget exists but the panel exposes no control for
  it, so this write cannot reach the prompt;
- `widget_value_invalid` — wrong type, or outside the enum or range the snapshot
  publishes.

Write a widget when the user is choosing a value in your UI. Do not write on a
timer, on every keystroke, or to enforce policy at submission time.

## Contribute graph effects to a submission

Policy that must hold for the *submitted* graph belongs in a contributor, not in
a widget write:

```ts
context.api.generation.registerSubmissionContributor({
  id: "loader-policy",
  apiVersion: 1,
  contribute: ({ session }) => {
    const loaders = session.workflow.nodes.filter(
      (node) => node.classType === "LoraLoader",
    );
    return loaders.flatMap((node) =>
      selection[node.id] === "none"
        ? [{ kind: "bypass-nodes" as const, nodeIds: [node.id] }]
        : [
            {
              kind: "set-widget" as const,
              target: { nodeId: node.id, widget: "lora_name" },
              value: selection[node.id],
            },
          ],
    );
  },
});
```

`contribute` runs **once per submission**, synchronously, against the session
that submission is planned from. What it returns is stored in the queued plan
and replayed from there, so it is never asked again: a queued generation keeps
the policy it was queued with even after your UI state changes, the user
switches workflow, or your package is disabled. Do not read the clock, a random
source, or live state you have not been handed — the same context must produce
the same effects.

Plan only from `context.session`, never from a snapshot you captured earlier.
The host pins a contribution to the workflow it was planned against and refuses
it if that is not the workflow being submitted, because a node id means
something different in a different workflow.

Effects address the graph rather than the panel, which is what makes them
different from `setWidget`: they can reach a widget with no panel control, and
`bypass-nodes` has no transaction equivalent at all. Node ids are the execution
ids the snapshot publishes, including `<instanceId>:<innerId>` inside a
subgraph instance. A target inside a subgraph definition that is instantiated
more than once, or a widget promoted to the enclosing instance, fails closed —
write the enclosing instance instead.

A contribution is all-or-nothing. If your callback throws, returns something
that is not an array of effects, exceeds a bound (64 effects, 256 bypass
targets per effect, 512 characters per node id or widget name, 100,000
serialized characters per value), names a node the workflow does not contain,
or writes a value the widget's own metadata rejects, the whole contribution is
refused and the submission fails before preprocessing — ahead of any GPU-bound
work — attributed to your contribution. That is deliberate: generating without the
policy the user set up would produce a result they did not ask for. Validate
against the snapshot you were given, and prefer contributing nothing to
contributing something you are unsure of.

Where your effect and a workflow rule write the same widget, yours wins and the
host records a collision diagnostic naming both. The registration is
owner-scoped: it disappears on deactivation, and disposing it removes the
policy from later submissions, never from queued ones.

## Compose AI UI with other domains

Use `assets.readBlob` and backend artifact/job APIs for model work. Use timeline
transactions for persisted editor changes. Keep previews local and non-mutating until
the user applies them. Do not turn a UI contribution into a second generation or
timeline mutation system.
