import type { ReactNode } from "react";

/**
 * Panel takeovers: one contributed body rendered *instead of* a panel's own,
 * inside that panel's frame.
 *
 * The mask panel already does this shape natively — a list, then a detail view
 * that replaces the body with a back control (`MaskPanel.tsx`, `isDetailView`)
 * — but it does it with component state, which only the panel's own author can
 * reach. A contribution that wanted the same shape had no way to ask for it:
 * a second registered view is a second *tab*, and a floating panel is not in
 * the panel at all.
 *
 * The generalisation is that every panel, host or contributed, in every
 * region, is already one `ShellViewEntry` rendered through one `ViewMount`.
 * So a takeover is keyed by **view id** and applied at the mount, which means
 * no panel has to know it can be taken over and none of them needs code for
 * it.
 *
 * Three rules keep that from being a way to hijack the editor:
 *
 * 1. **The host declares the targets.** A view is takeover-able only if its
 *    registration says so, exactly as a UI anchor exists only where the host
 *    emits one. A contribution cannot invent a target.
 * 2. **One at a time.** A second takeover of the same panel is refused rather
 *    than displacing the first, so two packages cannot fight over a panel and
 *    leave the user watching them flicker.
 * 3. **The host owns dismissal.** The back control is rendered by the frame,
 *    not by the contribution, so a panel can always be given back.
 */

export interface PanelTakeoverDefinition {
  /** Owner-qualified: `<extensionId>/<localId>`, or a host id. */
  readonly id: string;
  /** The `ShellViewEntry.id` this replaces the body of. */
  readonly targetViewId: string;
  /** Shown in the frame's back bar, so the user knows what took the panel. */
  readonly title: string;
  readonly component: (props: PanelTakeoverComponentProps) => ReactNode;
  /** Called when the *user* dismisses it, never on your own dispose. */
  readonly onDismissed?: () => void;
}

export interface PanelTakeoverComponentProps {
  readonly takeoverId: string;
  readonly viewId: string;
  /** Dismiss from inside the body; the frame's back control does the same. */
  readonly close: () => void;
}

export interface PanelTakeoverRegistration {
  readonly id: string;
  dispose(): void;
}

export type PanelTakeoverOpenResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "not_registered"
        /** The panel is gone, or no longer allows being taken over. */
        | "target_unavailable"
        /** Another package's takeover is showing; it is not displaced. */
        | "target_busy";
      readonly message: string;
    };

export class PanelTakeoverRegistry {
  private readonly declaredTargets = new Set<string>();
  private readonly registered = new Map<string, PanelTakeoverDefinition>();
  /** Target view id -> the takeover id currently showing in it. */
  private readonly active = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  /** Host-only: marks one view as a panel a contribution may take over. */
  declareTarget(viewId: string): void {
    this.declaredTargets.add(viewId);
    this.emit();
  }

  undeclareTarget(viewId: string): void {
    if (!this.declaredTargets.delete(viewId)) return;
    // Whatever was showing there has nowhere to render any more.
    this.active.delete(viewId);
    this.emit();
  }

  isDeclaredTarget(viewId: string): boolean {
    return this.declaredTargets.has(viewId);
  }

  /** Every panel a contribution may take over, for discovery. */
  listTargets(): readonly string[] {
    return [...this.declaredTargets].sort();
  }

  /**
   * Registers a takeover. The target does **not** have to exist yet.
   *
   * Panels are declared by the modules that render them, and the editor is
   * lazily loaded, so a package activates before `host.generate` exists at
   * all. Requiring the target here would mean an extension could only ever
   * take over panels that happened to be declared before it activated — a
   * silent, order-dependent failure rather than an error anyone could see.
   *
   * The rule that the host owns its targets is enforced where it decides
   * anything: `open` refuses an undeclared target, and the mount only swaps a
   * panel whose own definition opted in.
   */
  register(definition: PanelTakeoverDefinition): PanelTakeoverRegistration {
    if (this.registered.has(definition.id)) {
      throw new Error(`Panel takeover '${definition.id}' is already registered.`);
    }
    this.registered.set(definition.id, definition);
    this.emit();
    let disposed = false;
    return {
      id: definition.id,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.registered.delete(definition.id);
        // Disposing while showing gives the panel back; the owner is going
        // away, so there is nothing left to render.
        if (this.active.get(definition.targetViewId) === definition.id) {
          this.active.delete(definition.targetViewId);
        }
        this.emit();
      },
    };
  }

  open(takeoverId: string): PanelTakeoverOpenResult {
    const definition = this.registered.get(takeoverId);
    if (!definition) {
      return {
        ok: false,
        code: "not_registered",
        message: `Panel takeover '${takeoverId}' is not registered.`,
      };
    }
    // Revalidated on every open, not only at registration: a panel can be
    // disposed while a package still holds the registration, and a takeover
    // that reported success into a panel that no longer exists would sit
    // "open" against nothing — and reappear if that view id were registered
    // again later.
    if (!this.declaredTargets.has(definition.targetViewId)) {
      return {
        ok: false,
        code: "target_unavailable",
        message: `Panel '${definition.targetViewId}' is not available to take over.`,
      };
    }
    const showing = this.active.get(definition.targetViewId);
    if (showing !== undefined && showing !== takeoverId) {
      return {
        ok: false,
        code: "target_busy",
        message: `Panel '${definition.targetViewId}' is already taken over by '${showing}'.`,
      };
    }
    if (showing === takeoverId) return { ok: true };
    this.active.set(definition.targetViewId, takeoverId);
    this.emit();
    return { ok: true };
  }

  /**
   * Dismisses a takeover. `byUser` fires the owner's `onDismissed`, which is
   * how a package learns the panel was handed back without it asking — the
   * same distinction `claimTextInput` draws between revocation and disposal.
   */
  close(takeoverId: string, byUser = false): void {
    const definition = this.registered.get(takeoverId);
    if (!definition) return;
    if (this.active.get(definition.targetViewId) !== takeoverId) return;
    this.active.delete(definition.targetViewId);
    this.emit();
    if (byUser) definition.onDismissed?.();
  }

  /** The takeover showing in one panel, or null. */
  getActive(viewId: string): PanelTakeoverDefinition | null {
    const id = this.active.get(viewId);
    return id === undefined ? null : (this.registered.get(id) ?? null);
  }

  /** Every takeover an owner registered, for scope-wide disposal. */
  listForOwner(ownerId: string): readonly PanelTakeoverDefinition[] {
    const prefix = `${ownerId}/`;
    return [...this.registered.values()].filter((definition) =>
      definition.id.startsWith(prefix),
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.revision;
  }

  private emit(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

export const panelTakeovers = new PanelTakeoverRegistry();
