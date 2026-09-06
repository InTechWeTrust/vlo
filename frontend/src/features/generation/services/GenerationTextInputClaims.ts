/**
 * Authorship claims over the panel's text inputs
 * (docs/minimax-prompt-composer-extension-plan.md §4, 1C).
 *
 * Owner-neutral: a claim carries a human label and a reason, never an
 * extension identity or an activation. A tool that composes a prompt from
 * structured parts needs the box it writes to stop taking free edits behind
 * its back, and the user needs a way out that the tool can hear about — that
 * is the whole mechanism, and nothing about it is extension-specific.
 *
 * One claim per input. A second is refused rather than queued: two writers
 * over one prompt is not a state the panel can present honestly, and silently
 * displacing the first would make the escape hatch meaningless.
 */

export interface GenerationTextInputClaim {
  readonly inputId: string;
  /** Shown to the user as the reason the box is read-only. */
  readonly reason: string;
  /** Names the holder in the panel, e.g. an extension's display name. */
  readonly ownerLabel: string;
}

export interface GenerationTextInputClaimRegistration {
  readonly claim: GenerationTextInputClaim;
  /** Idempotent, and a no-op once the claim has been revoked. */
  release(): void;
}

export type GenerationTextInputClaimResult =
  | { readonly ok: true; readonly registration: GenerationTextInputClaimRegistration }
  | { readonly ok: false; readonly code: "input_already_claimed"; readonly message: string };

interface ClaimEntry {
  readonly claim: GenerationTextInputClaim;
  readonly onRevoked: (() => void) | undefined;
}

export class GenerationTextInputClaimService {
  private readonly claims = new Map<string, ClaimEntry>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  claim(options: {
    readonly inputId: string;
    readonly reason: string;
    readonly ownerLabel: string;
    /**
     * Called when the *user* takes the input back, never on a normal release.
     * Its holder is expected to stop tracking the text rather than overwrite
     * what the user then types.
     */
    readonly onRevoked?: () => void;
  }): GenerationTextInputClaimResult {
    const { inputId, reason, ownerLabel, onRevoked } = options;
    const existing = this.claims.get(inputId);
    if (existing) {
      return {
        ok: false,
        code: "input_already_claimed",
        message: `Input '${inputId}' is already claimed by ${existing.claim.ownerLabel}.`,
      };
    }

    const claim: GenerationTextInputClaim = Object.freeze({
      inputId,
      reason,
      ownerLabel,
    });
    const entry: ClaimEntry = { claim, onRevoked };
    this.claims.set(inputId, entry);
    this.bump();

    return {
      ok: true,
      registration: {
        claim,
        release: () => {
          // Identity-checked: a stale registration must not drop a claim some
          // later holder took over the same input.
          if (this.claims.get(inputId) !== entry) return;
          this.claims.delete(inputId);
          this.bump();
        },
      },
    };
  }

  getClaim(inputId: string): GenerationTextInputClaim | null {
    return this.claims.get(inputId)?.claim ?? null;
  }

  /**
   * The user's "edit anyway". Drops the claim and tells its holder, so the
   * holder can mark itself out of sync instead of writing over the user.
   */
  revoke(inputId: string): void {
    const entry = this.claims.get(inputId);
    if (!entry) return;
    this.claims.delete(inputId);
    this.bump();
    try {
      entry.onRevoked?.();
    } catch (error) {
      console.warn(
        `[generation] a text-input claim holder threw on revoke: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Payload-free notification, matching `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getRevision(): number {
    return this.revision;
  }

  /** Test seam. */
  reset(): void {
    this.claims.clear();
    this.bump();
  }

  private bump(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

export const generationTextInputClaims = new GenerationTextInputClaimService();
