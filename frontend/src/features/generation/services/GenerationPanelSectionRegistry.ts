import type { ReactNode } from "react";

export const GENERATION_PANEL_SECTION_LIMITS = Object.freeze({
  configLength: 100_000,
});

export interface GenerationPanelSectionPlacement {
  readonly placementId: string;
  readonly sectionId: string;
  readonly workflowId: string | null;
  readonly active: boolean;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface GenerationPanelSectionProviderDefinition {
  readonly providerId: string;
  readonly contributionId: string;
  render(placement: GenerationPanelSectionPlacement): ReactNode;
}

export interface GenerationPanelSectionProviderRegistration {
  readonly id: string;
  dispose(): void;
}

function assertNonEmptyId(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be non-empty.`);
  }
}

function providerKey(providerId: string, contributionId: string): string {
  return JSON.stringify([providerId, contributionId]);
}

function publicProviderId(providerId: string, contributionId: string): string {
  return `${providerId}/${contributionId}`;
}

/**
 * Owner-neutral generation-panel section providers.
 *
 * Workflow rules select a provider; native and extension adapters register the
 * renderer behind that identity. The registry knows nothing about activation
 * scopes or trusted React — those remain at the adapter boundary.
 */
export class GenerationPanelSectionRegistry {
  private readonly providers = new Map<
    string,
    Readonly<GenerationPanelSectionProviderDefinition>
  >();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  register(
    definition: GenerationPanelSectionProviderDefinition,
  ): GenerationPanelSectionProviderRegistration {
    assertNonEmptyId(definition.providerId, "Generation section provider ID");
    assertNonEmptyId(
      definition.contributionId,
      "Generation section contribution ID",
    );
    if (typeof definition.render !== "function") {
      throw new Error("Generation section providers must supply a renderer.");
    }

    const key = providerKey(definition.providerId, definition.contributionId);
    const id = publicProviderId(
      definition.providerId,
      definition.contributionId,
    );
    if (this.providers.has(key)) {
      throw new Error(`Generation section provider '${id}' is already registered.`);
    }

    const registered = Object.freeze({ ...definition });
    this.providers.set(key, registered);
    this.emitChange();

    let disposed = false;
    return Object.freeze({
      id,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.providers.get(key) === registered) {
          this.providers.delete(key);
          this.emitChange();
        }
      },
    });
  }

  get(
    providerId: string,
    contributionId: string,
  ): Readonly<GenerationPanelSectionProviderDefinition> | null {
    return this.providers.get(providerKey(providerId, contributionId)) ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.revision;
  }

  private emitChange(): void {
    this.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // UI/cache observers must not interfere with registration or disposal.
      }
    }
  }
}

export const generationPanelSectionRegistry =
  new GenerationPanelSectionRegistry();
