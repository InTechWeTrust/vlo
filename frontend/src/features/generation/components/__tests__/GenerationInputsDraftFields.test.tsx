import { DndContext, useDndContext } from "@dnd-kit/core";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GenerationInputs } from "../GenerationInputs";
import { GenerationInputsDraftFields } from "../GenerationInputsDraftFields";
import { useGenerationInputsDraft } from "../../draft/useGenerationInputsDraft";
import {
  mountGenerationSession,
  type MountedGenerationSession,
} from "../../../../testUtils/generationSession";
import { useGenerationStore } from "../../useGenerationStore";
import type { GenerationInputSnapshot } from "../../services/generationSessionTypes";
import type { WorkflowInput } from "../../types";

/**
 * The drag identities the panel and a staged editor register.
 *
 * A panel takeover does not unmount the panel behind it — `ViewRegionMount`
 * hides it with `display: none` so its state survives — and the whole editor
 * shares one `DndContext` (app/Editor.tsx). So while a staged editor is open,
 * both surfaces render the panel's field components for the same workflow
 * input, and `generationInputFields.tsx` derives the drop slot's dnd id from
 * the workflow input id alone.
 *
 * Both real components are mounted here rather than the shared field renderer
 * twice: the defect is that two *callers* end up asking for the same identity,
 * so a test that hands each surface its own id by hand would keep passing
 * while a real caller was left unfixed.
 *
 * See docs/staged-generation-editor-plan.md §2.3 and §3.3.
 */
const INPUT_ID = "141:image";
/** The panel's own registration, namespaced by its surface. */
const DROPPABLE_ID = `asset-slot-panel:${INPUT_ID}`;

const PANEL_INPUT: WorkflowInput = {
  id: INPUT_ID,
  nodeId: "141",
  classType: "LoadImage",
  inputType: "image",
  param: "image",
  label: "Start frame",
  currentValue: null,
  origin: "rule",
};

const SESSION_INPUT = {
  id: INPUT_ID,
  nodeId: "141",
  param: "image",
  label: "Start frame",
  inputType: "image",
  media: [],
} as unknown as GenerationInputSnapshot;

/** Renders the live droppable registry, so a test can read it from the DOM. */
function DroppableProbe() {
  const { droppableContainers } = useDndContext();
  return (
    <div data-testid="droppables">
      {[...droppableContainers.keys()].map(String).join(" ")}
    </div>
  );
}

/** The staged editor as a caller assembles it: one draft, one renderer. */
function StagedEditor() {
  const draft = useGenerationInputsDraft([INPUT_ID]);
  return <GenerationInputsDraftFields controller={draft} />;
}

function Editors({ takeoverOpen }: { takeoverOpen: boolean }) {
  return (
    <DndContext>
      <DroppableProbe />
      {/* The generation panel, mounted throughout — a takeover only hides it. */}
      <GenerationInputs
        inputs={[PANEL_INPUT]}
        textValues={{}}
        onTextValueCommit={vi.fn()}
        mediaInputs={{}}
        onInputDrop={vi.fn()}
        onExternalInputDrop={vi.fn()}
        onInputClear={vi.fn()}
        onSwapMediaInputs={vi.fn()}
        onMoveMediaInput={vi.fn()}
        onClickSelect={vi.fn()}
        widgetInputs={[]}
        widgetValues={{}}
        randomizeToggles={{}}
        onWidgetChange={vi.fn()}
        onToggleRandomize={vi.fn()}
      />
      {/* The staged editor, mounted over it during a takeover. */}
      {takeoverOpen ? <StagedEditor /> : null}
    </DndContext>
  );
}

const registeredIds = () =>
  (screen.getByTestId("droppables").textContent ?? "").split(" ");

let mounted: MountedGenerationSession | null = null;

/**
 * Mount the session *and* the panel's own input definitions.
 *
 * The staged editor reads its field definitions from the store rather than
 * rebuilding them from the snapshot (see `GenerationInputsDraft`), so without
 * these it renders nothing at all — and a collision test whose second surface
 * is empty passes for the wrong reason.
 */
function mountPanelAndSession(): void {
  mounted = mountGenerationSession({ inputs: [SESSION_INPUT] });
  useGenerationStore.setState({ workflowInputs: [PANEL_INPUT] });
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  useGenerationStore.setState({ workflowInputs: [] });
});

describe("staged editor drag identity", () => {
  it("registers the panel's drop slot", () => {
    mountPanelAndSession();
    const view = render(<Editors takeoverOpen={false} />);
    expect(registeredIds()).toContain(DROPPABLE_ID);
    view.unmount();
  });

  it("mounts both surfaces over the same input during a takeover", () => {
    mountPanelAndSession();
    const view = render(<Editors takeoverOpen={true} />);
    // Guards the two collision tests below. A staged editor that renders
    // nothing registers nothing, so those would pass for the wrong reason —
    // as they did before the panel's definitions were seeded into the store.
    expect(screen.getByTestId("generation-inputs-draft")).toBeTruthy();
    expect(screen.getAllByText("Start frame")).toHaveLength(2);
    view.unmount();
  });

  it("gives the panel and the staged editor separate drag identities", () => {
    mountPanelAndSession();
    const view = render(<Editors takeoverOpen={true} />);
    // Two surfaces are showing the same input, so there must be two slots to
    // drop onto — one registration means one of them silently cannot receive.
    expect(
      registeredIds().filter((id) => id.startsWith("asset-slot-")),
    ).toHaveLength(2);
    view.unmount();
  });

  /**
   * The regression this namespacing exists for.
   *
   * Both surfaces used to register the same droppable id, so the staged
   * editor's registration displaced the panel's. dnd-kit key-guards
   * *unregister*, so the panel's own cleanup was a no-op while the draft owned
   * the entry — and when the draft unmounted, its key matched and the entry was
   * deleted outright, leaving the panel mounted, visible, and unable to receive
   * drops. `useDroppable`'s effect deps are `[id]`, which never changes, so it
   * never re-registered.
   */
  it("keeps the panel's slot registered after a takeover closes", () => {
    mountPanelAndSession();
    const view = render(<Editors takeoverOpen={false} />);
    expect(registeredIds()).toContain(DROPPABLE_ID);

    view.rerender(<Editors takeoverOpen={true} />);
    view.rerender(<Editors takeoverOpen={false} />);

    expect(registeredIds()).toContain(DROPPABLE_ID);
    view.unmount();
  });
});
