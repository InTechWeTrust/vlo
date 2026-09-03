import { describe, expect, it, vi } from "vitest";
import { GenerationPanelSectionRegistry } from "../GenerationPanelSectionRegistry";

describe("GenerationPanelSectionRegistry", () => {
  it("registers one provider identity and disposes it idempotently", () => {
    const registry = new GenerationPanelSectionRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const render = vi.fn(() => null);

    const registration = registry.register({
      providerId: "example.path",
      contributionId: "canvas",
      render,
    });

    expect(registration.id).toBe("example.path/canvas");
    expect(registry.get("example.path", "canvas")?.render).toBe(render);
    expect(listener).toHaveBeenCalledTimes(1);

    registration.dispose();
    registration.dispose();
    expect(registry.get("example.path", "canvas")).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("rejects empty and duplicate provider identities", () => {
    const registry = new GenerationPanelSectionRegistry();
    const definition = {
      providerId: "example.path",
      contributionId: "canvas",
      render: () => null,
    };
    registry.register(definition);

    expect(() => registry.register(definition)).toThrow(/already registered/);
    expect(() =>
      registry.register({ ...definition, providerId: " " }),
    ).toThrow(/non-empty/);
  });

  it("does not conflate opaque provider and contribution identities", () => {
    const registry = new GenerationPanelSectionRegistry();
    registry.register({
      providerId: "native/provider",
      contributionId: "canvas",
      render: () => null,
    });
    registry.register({
      providerId: "native",
      contributionId: "provider/canvas",
      render: () => null,
    });

    expect(registry.get("native/provider", "canvas")).not.toBeNull();
    expect(registry.get("native", "provider/canvas")).not.toBeNull();
  });
});
