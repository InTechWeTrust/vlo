import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionApiScope,
  ExtensionResource,
  JsonValue,
} from "../..";
import { ExtensionUiSlot } from "../ExtensionUiSlot";
import { ExtensionModalHost } from "../ExtensionModalHost";
import {
  ExtensionUiSlotRegistry,
  extensionUiSlotRegistry,
} from "../ExtensionUiSlotRegistry";
import { hostContextKeys } from "../../../../core/shell/contextKeys";

function createScope(
  extensionId: string,
  report: ExtensionApiScope["report"] = vi.fn(),
): ExtensionApiScope {
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report,
  };
}

describe("ExtensionUiSlot", () => {
  it("reacts to owner-scoped native notice registration and disposal", () => {
    render(<ExtensionUiSlot slot="transformation-panel.before" />);
    expect(
      screen.queryByTestId(
        "extension-ui-contribution-example.color-grade/grade-help",
      ),
    ).not.toBeInTheDocument();

    let registration:
      | ReturnType<
          ReturnType<typeof extensionUiSlotRegistry.bind>["registerNotice"]
        >
      | undefined;
    act(() => {
      registration = extensionUiSlotRegistry
        .bind(createScope("example.color-grade"))
        .registerNotice({
          id: "grade-help",
          apiVersion: 1,
          slot: "transformation-panel.before",
          kind: "notice",
          title: "Film Grade",
          message: "Apply a host-rendered grade from the Add Transformation menu.",
          tone: "info",
        });
    });

    expect(
      screen.getByTestId(
        "extension-ui-contribution-example.color-grade/grade-help",
      ),
    ).toHaveTextContent("Film Grade");

    act(() => registration?.dispose());
    expect(
      screen.queryByTestId(
        "extension-ui-contribution-example.color-grade/grade-help",
      ),
    ).not.toBeInTheDocument();
  });

  it("renders inline notices compactly so they fit a toolbar", () => {
    const registration = extensionUiSlotRegistry
      .bind(createScope("example.notice"))
      .registerNotice({
        id: "hint",
        apiVersion: 1,
        slot: "timeline.toolbar",
        kind: "notice",
        title: "Beat sync",
        message: "Detect beats before adding markers.",
        tone: "info",
      });

    render(<ExtensionUiSlot slot="timeline.toolbar" presentation="inline" />);
    // Compact chip shows the title; the full-height Alert (role="alert") that
    // would overflow the 40px toolbar is not rendered inline.
    expect(screen.getByText("Beat sync")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    act(() => registration.dispose());
  });

  it("accepts trusted contributions to the timeline.toolbar slot", () => {
    const registration = extensionUiSlotRegistry
      .bind(createScope("example.toolbar"))
      .registerComponent({
        id: "beat-tool",
        apiVersion: 1,
        slot: "timeline.toolbar",
        kind: "trusted-react",
        component: () => <button type="button">Beat tool</button>,
      });

    render(<ExtensionUiSlot slot="timeline.toolbar" presentation="inline" />);
    expect(
      screen.getByRole("button", { name: "Beat tool" }),
    ).toBeInTheDocument();

    act(() => registration.dispose());
    expect(
      screen.queryByRole("button", { name: "Beat tool" }),
    ).not.toBeInTheDocument();
  });

  it("validates slot metadata before registration", () => {
    const registry = new ExtensionUiSlotRegistry();
    const api = registry.bind(createScope("example.ui"));

    expect(() =>
      api.registerNotice({
        id: "empty-message",
        apiVersion: 1,
        slot: "transformation-panel.before",
        kind: "notice",
        title: "Title",
        message: "",
      }),
    ).toThrow(/message must be a non-empty string/);
    expect(registry.list("transformation-panel.before")).toEqual([]);
    expect(() =>
      api.registerComponent({
        id: "unknown-slot",
        apiVersion: 1,
        slot: "undeclared.surface",
        kind: "trusted-react",
        component: () => null,
      }),
    ).toThrow(/undeclared host slot/);
  });

  it("renders and isolates trusted React component contributions", () => {
    const report = vi.fn();
    const registration = extensionUiSlotRegistry
      .bind(createScope("example.react", report))
      .registerComponent({
        id: "custom-panel",
        apiVersion: 1,
        slot: "transformation-panel.before",
        kind: "trusted-react",
        component: () => <button type="button">Custom extension control</button>,
      });

    render(<ExtensionUiSlot slot="transformation-panel.before" />);
    expect(
      screen.getByRole("button", { name: "Custom extension control" }),
    ).toBeInTheDocument();

    act(() => registration.dispose());
    expect(
      screen.queryByRole("button", { name: "Custom extension control" }),
    ).not.toBeInTheDocument();
    expect(report).not.toHaveBeenCalled();
  });

  it("contains trusted component render failures", () => {
    const report = vi.fn();
    const registration = extensionUiSlotRegistry
      .bind(createScope("example.broken-react", report))
      .registerComponent({
        id: "broken-panel",
        apiVersion: 1,
        slot: "transformation-panel.before",
        kind: "trusted-react",
        component: () => {
          throw new Error("component failed");
        },
      });

    render(<ExtensionUiSlot slot="transformation-panel.before" />);

    expect(report).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("example.broken-react/broken-panel"),
      expect.objectContaining({ error: expect.any(Error) }),
    );
    registration.dispose();
  });

  it("hosts owner-bound trusted modals and resolves their result", async () => {
    const api = extensionUiSlotRegistry.bind(createScope("example.modal"));
    const registration = api.registerModal({
      id: "prompt-builder",
      apiVersion: 1,
      kind: "trusted-modal",
      title: "Prompt builder",
      component: ({ input, close }) => (
        <button
          type="button"
          onClick={() => close({ accepted: input ?? null })}
        >
          Apply modal
        </button>
      ),
    });
    let result: Promise<JsonValue | undefined>;
    act(() => {
      result = api.openModal("prompt-builder", { source: "generation" });
    });
    expect(
      extensionUiSlotRegistry.getActiveModal()?.contribution.definition,
    ).toMatchObject({ kind: "trusted-modal", size: "medium" });
    render(<ExtensionModalHost />);

    fireEvent.click(screen.getByRole("button", { name: "Apply modal" }));
    await expect(result!).resolves.toEqual({
      accepted: { source: "generation" },
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    registration.dispose();
  });

  it("closes an active modal when its owner registration is disposed", async () => {
    const api = extensionUiSlotRegistry.bind(createScope("example.modal-dispose"));
    const registration = api.registerModal({
      id: "temporary",
      apiVersion: 1,
      kind: "trusted-modal",
      title: "Temporary",
      component: () => null,
    });
    const result = api.openModal("temporary");

    act(() => registration.dispose());

    await expect(result).resolves.toBeUndefined();
  });

});

describe("slot anchors", () => {
  it("accepts a family anchor and still refuses everything undeclared", () => {
    const registry = new ExtensionUiSlotRegistry();
    const api = registry.bind(createScope("example.anchors"));

    // A workflow's section ids are not known when an extension activates, so
    // the host declares the shape rather than every literal target.
    expect(() =>
      api.registerComponent({
        id: "under-prompts",
        apiVersion: 1,
        slot: "generation.section.prompts.after",
        kind: "trusted-react",
        component: () => null,
      }),
    ).not.toThrow();
    // Snake_case section ids are the convention in the shipped rules files.
    expect(() =>
      api.registerComponent({
        id: "under-video",
        apiVersion: 1,
        slot: "generation.section.video_generation.before",
        kind: "trusted-react",
        component: () => null,
      }),
    ).not.toThrow();

    // A family is not a wildcard over the whole namespace: it matches one
    // segment, at the position the host put it.
    for (const slot of [
      "generation.section.prompts.middle",
      "generation.section.a.b.after",
      "generation.anything.prompts.after",
      "generation.section..after",
    ]) {
      expect(() =>
        api.registerComponent({
          id: `bad-${slot}`,
          apiVersion: 1,
          slot,
          kind: "trusted-react",
          component: () => null,
        }),
      ).toThrow(/undeclared host slot/);
    }
  });

  it("rejects a malformed when clause and detaches the one it keeps", () => {
    const registry = new ExtensionUiSlotRegistry();
    const api = registry.bind(createScope("example.anchors"));

    // TypeScript does not constrain what a package actually passes, and a
    // clause stored unvalidated would evaluate true forever.
    for (const when of [
      { not: null },
      { key: 42 },
      {},
      { key: "a", or: [] },
      { and: "nope" },
      null,
    ]) {
      expect(() =>
        api.registerComponent({
          id: `bad-when-${JSON.stringify(when)}`,
          apiVersion: 1,
          slot: "generation.toolbar",
          kind: "trusted-react",
          when: when as never,
          component: () => null,
        }),
      ).toThrow(/'when'/);
    }

    // The clause is the package's data; a registration that kept the caller's
    // object could be rewritten after the host validated it.
    const mutable = { key: "project.open" };
    api.registerComponent({
      id: "detached",
      apiVersion: 1,
      slot: "generation.toolbar",
      kind: "trusted-react",
      when: mutable,
      component: () => null,
    });
    mutable.key = "something.else";
    const stored = registry
      .list("generation.toolbar")
      .find((entry) => entry.id === "example.anchors/detached");
    expect((stored?.definition as { when?: unknown }).when).toEqual({
      key: "project.open",
    });
    expect(() => {
      (stored?.definition as { when: { key: string } }).when.key = "mutated";
    }).toThrow();
  });

  it("mounts a contribution only while its when clause holds", () => {
    // The slot renders from the global registry, so this drives that one and
    // the real context-key service rather than a local double.
    hostContextKeys.set("test.anchor.visible", false);
    let registration:
      | ReturnType<
          ReturnType<typeof extensionUiSlotRegistry.bind>["registerComponent"]
        >
      | undefined;
    act(() => {
      registration = extensionUiSlotRegistry
        .bind(createScope("example.anchors"))
        .registerComponent({
          id: "gated",
          apiVersion: 1,
          slot: "generation.toolbar",
          kind: "trusted-react",
          when: { key: "test.anchor.visible" },
          component: () => <span>anchored</span>,
        });
    });

    const view = render(<ExtensionUiSlot slot="generation.toolbar" />);
    expect(screen.queryByText("anchored")).not.toBeInTheDocument();
    act(() => void hostContextKeys.set("test.anchor.visible", true));
    expect(screen.getByText("anchored")).toBeInTheDocument();
    act(() => void hostContextKeys.set("test.anchor.visible", false));
    expect(screen.queryByText("anchored")).not.toBeInTheDocument();

    view.unmount();
    act(() => void registration?.dispose());
    hostContextKeys.set("test.anchor.visible", undefined);
  });
});
