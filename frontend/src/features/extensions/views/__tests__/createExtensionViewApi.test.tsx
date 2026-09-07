import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { HostContextKeyService } from "../../../../core/shell/contextKeys";
import { HostViewRegistry } from "../../../../core/shell/viewRegistry";
import { ViewRegionMount } from "../../../../core/shell/ViewRegionMount";
import { createExtensionViewApi } from "../createExtensionViewApi";

function createScope(id: string): ExtensionApiScope {
  return {
    extension: { id, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: vi.fn(),
  };
}

describe("createExtensionViewApi", () => {
  it("registers, opens, isolates, and disposes an owner-qualified view", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    const api = createExtensionViewApi(createScope("example.views"), registry);
    const registration = api.registerView({
      id: "dashboard",
      apiVersion: 1,
      kind: "trusted-view",
      title: "Dashboard",
      defaultRegion: "projects-page.main",
      component: ({ viewId, region, active }) => (
        <div>{`${viewId}:${region}:${active}`}</div>
      ),
    });

    expect(registration.id).toBe("example.views/dashboard");
    expect(api.openView("dashboard")).toBe(true);
    const views = registry.list("projects-page.main");
    render(
      <ViewRegionMount
        region="projects-page.main"
        views={views}
        activeViewId="example.views/dashboard"
      />,
    );
    expect(
      screen.getByText(
        "example.views/dashboard:projects-page.main:true",
      ),
    ).toBeInTheDocument();
    expect(
      globalThis.getComputedStyle(screen.getByRole("tabpanel")),
    ).toMatchObject({ minHeight: "0", overflow: "hidden" });

    registration.dispose();
    expect(registry.get("example.views/dashboard")).toBeUndefined();
  });

  it("keeps a view single-region unless it opts into portability", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    const api = createExtensionViewApi(createScope("example.views"), registry);
    api.registerView({
      id: "fixed",
      apiVersion: 1,
      kind: "trusted-view",
      title: "Fixed",
      defaultRegion: "left-sidebar",
      component: () => null,
    });
    // Every extension view shipped before this seam existed keeps exactly this
    // shape, so nothing that already works changes mount path or gains a move
    // control it was not written for.
    expect(registry.get("example.views/fixed")?.allowedRegions).toEqual([
      "left-sidebar",
    ]);
  });

  it("carries a declared allowedRegions list onto the registry entry", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    const api = createExtensionViewApi(createScope("example.views"), registry);
    api.registerView({
      id: "portable",
      apiVersion: 1,
      kind: "trusted-view",
      title: "Portable",
      defaultRegion: "right-sidebar",
      allowedRegions: ["bottom-dock", "right-sidebar"],
      component: () => null,
    });
    // Canonical dock order, not the order it was spelled in: move menus and
    // descriptor comparisons depend on it being stable.
    expect(registry.get("example.views/portable")?.allowedRegions).toEqual([
      "right-sidebar",
      "bottom-dock",
    ]);
  });

  it("renders a portable extension view through the stable container", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    const api = createExtensionViewApi(createScope("example.views"), registry);
    api.registerView({
      id: "portable",
      apiVersion: 1,
      kind: "trusted-view",
      title: "Portable",
      defaultRegion: "right-sidebar",
      allowedRegions: ["right-sidebar", "bottom-dock"],
      component: () => <div>portable body</div>,
    });
    const { container } = render(
      <ViewRegionMount
        region="right-sidebar"
        views={registry.list("right-sidebar")}
        activeViewId="example.views/portable"
      />,
    );
    // The region slot adopts a container it does not own; the panel itself is
    // rendered by ShellPortableViewHost, which is not mounted here. Proving the
    // slot is the portable one is what matters: a move is then a DOM adoption
    // rather than a remount.
    expect(
      container.querySelector('[data-portable-view-slot="example.views/portable"]'),
    ).not.toBeNull();
    expect(screen.queryByText("portable body")).toBeNull();
  });

  it("rejects an allowedRegions list the layout kernel cannot honour", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    const api = createExtensionViewApi(createScope("example.views"), registry);
    const base = {
      apiVersion: 1,
      kind: "trusted-view",
      title: "Portable",
      component: () => null,
    } as const;

    // A floating panel has no dock to be moved between.
    expect(() =>
      api.registerView({
        ...base,
        id: "overlay",
        defaultRegion: "editor-overlay",
        allowedRegions: ["right-sidebar"],
      }),
    ).toThrow(/outside the dock regions/);

    // A move menu must never be able to strand a panel outside its own list.
    expect(() =>
      api.registerView({
        ...base,
        id: "missing-default",
        defaultRegion: "left-sidebar",
        allowedRegions: ["right-sidebar"],
      }),
    ).toThrow(/must include its default region/);

    expect(() =>
      api.registerView({
        ...base,
        id: "empty",
        defaultRegion: "left-sidebar",
        allowedRegions: [],
      }),
    ).toThrow(/non-empty array/);

    expect(() =>
      api.registerView({
        ...base,
        id: "not-a-dock",
        defaultRegion: "left-sidebar",
        allowedRegions: ["left-sidebar", "projects-page.main" as "bottom-dock"],
      }),
    ).toThrow(/cannot be moved to region/);

    // Every rejection leaves nothing half-registered.
    for (const id of ["overlay", "missing-default", "empty", "not-a-dock"]) {
      expect(registry.get(`example.views/${id}`)).toBeUndefined();
    }
  });

  it("does not let an extension reopen a user-hidden view", () => {
    const registry = new HostViewRegistry(new HostContextKeyService(), null);
    const api = createExtensionViewApi(createScope("example.views"), registry);
    api.registerView({
      id: "hidden",
      apiVersion: 1,
      kind: "trusted-view",
      title: "Hidden",
      defaultRegion: "left-sidebar",
      component: () => null,
    });
    registry.setUserVisible("example.views/hidden", false);

    expect(api.openView("hidden")).toBe(false);
  });
});
