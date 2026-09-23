import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../..";
import { createVloExtensionApi } from "../../services/FrontendExtensionRuntime";
import {
  mountGenerationSession,
  type MountedGenerationSession,
} from "../../../../testUtils/generationSession";
import { GenerationInputs } from "../../../generation/components/GenerationInputs";
import type {
  GenerationInputSnapshot,
  GenerationMediaItemSnapshot,
} from "../../../generation/services/generationSessionTypes";
import { activate } from "../../../../../../extension-fixtures/reference-prompt/frontend/src/index";

/**
 * The tracked, provider-neutral fixture for the staged editor, media occurrence
 * identity and the draft commit reading (docs/minimax-ref2v-prompt-composer-plan.md
 * §3.4, the R0 gate).
 *
 * It runs in a clean checkout — unlike the MiniMax suites, which need the
 * out-of-tree package — and drives the real extension API, the real draft
 * controller and the real session through a package's `activate`. What it
 * proves is the shape every reference-aware prompt tool depends on: prose bound
 * to occurrence ids is renumbered by a staged reorder and resolved inside the
 * commit, against the arrangement that commit writes.
 */

function item(itemId: string, assetId: string, ordinal: number): GenerationMediaItemSnapshot {
  return {
    slotId: ordinal === 0 ? "10:images" : `10:images::repeat::${ordinal}`,
    itemId,
    ordinal,
    source: "asset",
    assetId,
    displayName: `${assetId}.png`,
    mediaType: "image",
    hasAudio: false,
    options: {},
    preparing: false,
  };
}

const BATCH: GenerationInputSnapshot = {
  id: "10:images",
  nodeId: "10",
  param: "images",
  label: "Reference images",
  inputType: "image",
  repeatable: { max: 4, optionIds: [] },
  media: [item("media-hero", "hero", 0), item("media-city", "city", 1)],
};

const PROMPT: GenerationInputSnapshot = {
  id: "6:text",
  nodeId: "6",
  param: "text",
  label: "Prompt",
  inputType: "text",
  value: "",
};

let session: MountedGenerationSession | null = null;
const resources: ExtensionResource[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    if (typeof resource === "function") await resource();
    else await resource.dispose();
  }
  session?.unmount();
  session = null;
});

async function mountFixture() {
  const scope: ExtensionApiScope = {
    extension: { id: "example.reference-prompt", version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => {
      resources.push(resource);
      return resource;
    },
    report: vi.fn(),
  };
  session = mountGenerationSession({ inputs: [BATCH, PROMPT] });
  const api = createVloExtensionApi(scope);
  await activate({
    extension: scope.extension,
    sdkVersion: "1.0.0",
    signal: scope.signal,
    api,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onDispose: (resource) => resources.push(resource),
    exportApi: vi.fn(),
  });
  render(
    <GenerationInputs
      inputs={[]}
      sections={[
        {
          id: "references",
          title: "Reference prompt",
          extension: {
            extension_id: "example.reference-prompt",
            contribution_id: "reference-prompt",
            config: { referenceInputId: "10:images", promptInputId: "6:text" },
          },
        },
      ]}
      workflowId="reference-workflow.json"
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
    />,
  );
}

function template(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Reference prompt template" }) as HTMLTextAreaElement;
}

function append(text: string) {
  fireEvent.change(template(), { target: { value: `${template().value}${text}` } });
}

function preview(): string {
  return screen.getByLabelText("Resolved prompt").textContent ?? "";
}

describe("reference prompt conformance fixture", () => {
  it("keeps citations on their items through a staged reorder, and resolves them in the commit", async () => {
    await mountFixture();

    append("A portrait of ");
    fireEvent.click(screen.getByRole("button", { name: "Insert [Ref 1] (hero.png)" }));
    append(" in ");
    fireEvent.click(screen.getByRole("button", { name: "Insert [Ref 2] (city.png)" }));
    expect(template().value).toBe("A portrait of {{ref:media-hero}} in {{ref:media-city}}");
    expect(preview()).toBe("A portrait of [Ref 1] in [Ref 2]");

    fireEvent.click(screen.getByRole("button", { name: "Move last reference first" }));

    // Same citations, new numbers: the hero is now the second reference.
    expect(preview()).toBe("A portrait of [Ref 2] in [Ref 1]");
    expect(session!.commit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Commit prompt" }));

    expect(session!.commit).toHaveBeenCalledOnce();
    const panel = session!.panelInputs();
    expect(panel.find((input) => input.id === "6:text")?.value).toBe(
      "A portrait of [Ref 2] in [Ref 1]",
    );
    // The staged move and the text landed in one transaction, and the items
    // kept the identities the prose was bound to.
    expect(
      panel.find((input) => input.id === "10:images")?.media?.map((entry) => entry.itemId),
    ).toEqual(["media-city", "media-hero"]);
    expect(screen.getByRole("status")).toHaveTextContent("Committed.");
  });

  it("holds the prompt without ever addressing it as a staged input", async () => {
    await mountFixture();
    append("held");
    expect(screen.getByTestId("staged-inputs")).toHaveTextContent(/^10:images$/);
  });

  it("refuses to commit a citation whose item has left the batch", async () => {
    await mountFixture();
    fireEvent.click(screen.getByRole("button", { name: "Insert [Ref 2] (city.png)" }));

    // The panel removes the cited item; the draft is not holding changes to
    // the batch, so this is not a conflict — it is a reference with nothing
    // to name, and the remaining item must not inherit its number.
    act(() => {
      session!.publish({ inputs: [{ ...BATCH, media: [item("media-hero", "hero", 0)] }, PROMPT] });
    });
    expect(preview()).toBe("1 reference(s) no longer resolve.");

    fireEvent.click(screen.getByRole("button", { name: "Commit prompt" }));

    expect(session!.commit).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("1 reference(s) no longer resolve.");
  });

  it("turns a prompt edited in the panel meanwhile into a conflict, not an overwrite", async () => {
    await mountFixture();
    append("draft");

    act(() => {
      session!.publish({ inputs: [BATCH, { ...PROMPT, value: "typed in the panel" }] });
    });

    expect(screen.getByRole("button", { name: "Commit prompt" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Prompt changed in the panel while you were editing.",
    );
    expect(session!.commit).not.toHaveBeenCalled();
  });
});
