import { useEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PanelTakeoverRegistry, panelTakeovers } from "../panelTakeovers";
import { HostViewRegistry } from "../viewRegistry";
import { HostContextKeyService } from "../contextKeys";
import { ViewRegionMount } from "../ViewRegionMount";

function createRegistries() {
  const takeovers = new PanelTakeoverRegistry();
  const views = new HostViewRegistry(new HostContextKeyService(), null, takeovers);
  return { takeovers, views };
}

describe("panel takeovers", () => {
  it("refuses to open a target the host has not opted in", () => {
    const { takeovers, views } = createRegistries();
    views.registerHostView({
      id: "host.plain",
      title: "Plain",
      defaultRegion: "right-sidebar",
      component: () => null,
    });

    // Registration does not require the target to exist: panels are declared
    // by the modules that render them and the editor loads lazily, so a
    // package always activates first. Refusing here would make a takeover
    // possible only for panels that happened to be declared already.
    const registration = takeovers.register({
      id: "example.pkg/body",
      targetViewId: "host.plain",
      title: "Body",
      component: () => null,
    });

    // The rule is enforced where it decides something. A registered panel is
    // not a target unless its own definition opted in, so this one is refused.
    expect(takeovers.isDeclaredTarget("host.plain")).toBe(false);
    expect(takeovers.open("example.pkg/body")).toMatchObject({
      ok: false,
      code: "target_unavailable",
    });
    expect(takeovers.getActive("host.plain")).toBeNull();
    registration.dispose();
  });

  it("opens into a panel declared after the takeover was registered", () => {
    const { takeovers, views } = createRegistries();
    // The real order: the package activates, then the editor chunk loads and
    // declares its panels.
    takeovers.register({
      id: "example.pkg/body",
      targetViewId: "host.late",
      title: "Body",
      component: () => null,
    });
    expect(takeovers.open("example.pkg/body")).toMatchObject({
      ok: false,
      code: "target_unavailable",
    });

    views.registerHostView({
      id: "host.late",
      title: "Late",
      defaultRegion: "right-sidebar",
      takeoverable: true,
      component: () => null,
    });
    expect(takeovers.open("example.pkg/body")).toEqual({ ok: true });
  });

  it("refuses a second takeover rather than displacing the first", () => {
    const { takeovers, views } = createRegistries();
    views.registerHostView({
      id: "host.target",
      title: "Target",
      defaultRegion: "right-sidebar",
      takeoverable: true,
      component: () => null,
    });
    takeovers.register({
      id: "example.first/body",
      targetViewId: "host.target",
      title: "First",
      component: () => null,
    });
    takeovers.register({
      id: "example.second/body",
      targetViewId: "host.target",
      title: "Second",
      component: () => null,
    });

    expect(takeovers.open("example.first/body")).toEqual({ ok: true });
    // Two packages must not be able to fight over one panel.
    expect(takeovers.open("example.second/body")).toMatchObject({
      ok: false,
      code: "target_busy",
    });
    expect(takeovers.getActive("host.target")?.title).toBe("First");
    // Re-opening the one already showing is not an error.
    expect(takeovers.open("example.first/body")).toEqual({ ok: true });
  });

  it("gives the panel back when the owner goes away or the panel does", () => {
    const { takeovers, views } = createRegistries();
    const panel = views.registerHostView({
      id: "host.target",
      title: "Target",
      defaultRegion: "right-sidebar",
      takeoverable: true,
      component: () => null,
    });
    const registration = takeovers.register({
      id: "example.pkg/body",
      targetViewId: "host.target",
      title: "Body",
      component: () => null,
    });

    takeovers.open("example.pkg/body");
    registration.dispose();
    // Deactivation disposes the registration, and nothing may be left
    // rendering in a panel whose owner is gone.
    expect(takeovers.getActive("host.target")).toBeNull();

    const second = takeovers.register({
      id: "example.pkg/body",
      targetViewId: "host.target",
      title: "Body",
      component: () => null,
    });
    takeovers.open("example.pkg/body");
    panel.dispose();
    expect(takeovers.isDeclaredTarget("host.target")).toBe(false);
    expect(takeovers.getActive("host.target")).toBeNull();
    second.dispose();
  });

  it("tells the owner when the user takes the panel back, but not when it does", () => {
    const { takeovers, views } = createRegistries();
    views.registerHostView({
      id: "host.target",
      title: "Target",
      defaultRegion: "right-sidebar",
      takeoverable: true,
      component: () => null,
    });
    const onDismissed = vi.fn();
    takeovers.register({
      id: "example.pkg/body",
      targetViewId: "host.target",
      title: "Body",
      component: () => null,
      onDismissed,
    });

    takeovers.open("example.pkg/body");
    takeovers.close("example.pkg/body");
    // Closing itself is not being dismissed; the distinction is what lets a
    // package tell "I finished" from "the user wanted the panel".
    expect(onDismissed).not.toHaveBeenCalled();

    takeovers.open("example.pkg/body");
    takeovers.close("example.pkg/body", true);
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });

  it("refuses to open into a panel that has gone away", () => {
    const { takeovers, views } = createRegistries();
    const panel = views.registerHostView({
      id: "host.target",
      title: "Target",
      defaultRegion: "right-sidebar",
      takeoverable: true,
      component: () => null,
    });
    takeovers.register({
      id: "example.pkg/body",
      targetViewId: "host.target",
      title: "Body",
      component: () => null,
    });

    panel.dispose();
    // The registration outlives the panel — the package still holds it — so
    // the target is revalidated on every open rather than only at
    // registration. Reporting success into a panel that does not exist would
    // also resurrect the takeover if that view id ever registered again.
    expect(takeovers.open("example.pkg/body")).toMatchObject({
      ok: false,
      code: "target_unavailable",
    });
    expect(takeovers.getActive("host.target")).toBeNull();

    views.registerHostView({
      id: "host.target",
      title: "Target",
      defaultRegion: "right-sidebar",
      takeoverable: true,
      component: () => null,
    });
    expect(takeovers.getActive("host.target")).toBeNull();
  });

  it("renders the body in the panel's frame, with a back control the host owns", () => {
    // The mount reads the singleton, so this drives the real one rather than a
    // double — the point of the test is that the shared mount does the swap.
    const takeovers = panelTakeovers;
    const views = new HostViewRegistry(
      new HostContextKeyService(),
      null,
      takeovers,
    );
    views.registerHostView({
      id: "host.target",
      title: "Generate",
      defaultRegion: "right-sidebar",
      takeoverable: true,
      component: () => <div>panel body</div>,
    });
    const registration = takeovers.register({
      id: "example.render/body",
      targetViewId: "host.target",
      title: "MiniMax prompt",
      component: ({ close }) => (
        <button type="button" onClick={close}>
          contributed body
        </button>
      ),
    });

    const entry = views.get("host.target");
    if (!entry) throw new Error("panel missing");
    const view = render(
      <ViewRegionMount
        region="right-sidebar"
        views={[entry]}
        activeViewId="host.target"
      />,
    );

    expect(screen.getByText("panel body")).toBeInTheDocument();
    expect(screen.queryByText("contributed body")).not.toBeInTheDocument();

    act(() => void takeovers.open("example.render/body"));
    expect(screen.getByText("contributed body")).toBeInTheDocument();
    expect(screen.getByText("MiniMax prompt")).toBeInTheDocument();
    // Hidden rather than unmounted: the panel's state is expensive to rebuild
    // and handing it back should return what the user had.
    expect(screen.getByText("panel body")).toBeInTheDocument();

    // The frame renders the back control, so the panel can always be returned.
    act(() => void fireEvent.click(screen.getByLabelText("Back to Generate")));
    expect(screen.queryByText("contributed body")).not.toBeInTheDocument();
    expect(screen.getByText("panel body")).toBeInTheDocument();
    view.unmount();
    registration.dispose();
    takeovers.undeclareTarget("host.target");
  });

  it("keeps the panel mounted across a takeover, not just visible", () => {
    const takeovers = panelTakeovers;
    const views = new HostViewRegistry(
      new HostContextKeyService(),
      null,
      takeovers,
    );
    const mounts = vi.fn();
    function StatefulPanel() {
      useEffect(() => {
        mounts();
      }, []);
      return <div>panel body</div>;
    }
    views.registerHostView({
      id: "host.stateful",
      title: "Generate",
      defaultRegion: "right-sidebar",
      keepMounted: true,
      eager: true,
      takeoverable: true,
      component: () => <StatefulPanel />,
    });
    const registration = takeovers.register({
      id: "example.stateful/body",
      targetViewId: "host.stateful",
      title: "Body",
      component: () => <div>contributed body</div>,
    });

    const entry = views.get("host.stateful");
    if (!entry) throw new Error("panel missing");
    const view = render(
      <ViewRegionMount
        region="right-sidebar"
        views={[entry]}
        activeViewId="host.stateful"
      />,
    );
    expect(mounts).toHaveBeenCalledTimes(1);

    // Moving the panel between tree positions would remount it, throwing away
    // exactly the state `keepMounted` exists to protect — on open *and* close.
    act(() => void takeovers.open("example.stateful/body"));
    expect(mounts).toHaveBeenCalledTimes(1);
    act(() => void takeovers.close("example.stateful/body"));
    expect(mounts).toHaveBeenCalledTimes(1);

    view.unmount();
    registration.dispose();
    takeovers.undeclareTarget("host.stateful");
  });

});
