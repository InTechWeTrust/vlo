import { GenerationInputsDraft } from "../../generation";
import type { GenerationInputsDraftController } from "../../generation";
import { generationSessionService } from "../../generation/services/GenerationSessionService";
import { projectGenerationSession } from "./generationSessionProjection";
import { createExtensionTransactionPort } from "./extensionGenerationTransactionPort";
import { PUBLIC_FAILURE_CODES } from "./ExtensionGenerationBridge";
import type {
  ExtensionGenerationInputSnapshot,
  ExtensionGenerationTransaction,
  ExtensionGenerationTransactionResult,
} from "../types";

/**
 * The staged inputs editor, as an extension may use it.
 *
 * The host controller writes through the *native* transaction, which is not
 * something package code may hold: its failures are store-shaped rather than
 * the SDK's closed code union, and a throw from a package callback inside it
 * would escape as a raw error. So the controller is re-presented here —
 * projected inputs instead of host snapshots, and `additionalWrites` handed
 * the same owner-bound port `api.generation.transaction` uses.
 */
export interface ExtensionGenerationInputsDraftController {
  readonly inputs: readonly ExtensionGenerationInputSnapshot[];
  readonly hasDraftChanges: boolean;
  readonly hasConflict: boolean;
  readonly canCommit: boolean;
  readonly error: string | null;
  commit(
    label: string,
    additionalWrites?: (transaction: ExtensionGenerationTransaction) => void,
  ): ExtensionGenerationTransactionResult;
  revert(): void;
}

export interface ExtensionGenerationInputsDraftProps {
  readonly inputIds: readonly string[];
  readonly children?: (
    controller: ExtensionGenerationInputsDraftController,
  ) => unknown;
}

function publicResult(
  result: ReturnType<GenerationInputsDraftController["commit"]>,
): ExtensionGenerationTransactionResult {
  if (result.ok) {
    return { ok: true, changed: result.changed, label: result.label };
  }
  return {
    ok: false,
    code: PUBLIC_FAILURE_CODES[result.code] ?? "callback_failed",
    message: result.message,
    label: result.label,
  };
}

/**
 * The projected inputs, as the SDK publishes them.
 *
 * Runs the draft's inputs back through the same projection the session uses,
 * so a staged input and a committed one are described identically — including
 * the truncation limits, which a package would otherwise see applied to some
 * of its inputs and not others.
 */
function projectDraftInputs(
  inputs: readonly unknown[],
): readonly ExtensionGenerationInputSnapshot[] {
  const snapshot = generationSessionService.getSnapshot();
  if (!snapshot) return [];
  const projected = projectGenerationSession({
    ...snapshot,
    inputs: inputs as typeof snapshot.inputs,
  }).session;
  return projected.inputs;
}

export function ExtensionGenerationInputsDraft({
  inputIds,
  children,
}: ExtensionGenerationInputsDraftProps) {
  return (
    <GenerationInputsDraft inputIds={inputIds}>
      {(controller) => {
        if (!children) return null;
        const bound: ExtensionGenerationInputsDraftController = {
          inputs: projectDraftInputs(controller.inputs),
          hasDraftChanges: controller.hasDraftChanges,
          hasConflict: controller.hasConflict,
          canCommit: controller.canCommit,
          error: controller.error,
          commit: (label, additionalWrites) =>
            publicResult(
              controller.commit(label, (session) => {
                if (!additionalWrites) return;
                // The same port every other extension write crosses, so a
                // bad id or an oversize value is refused here and rolls the
                // whole staged commit back rather than reaching the store.
                additionalWrites(createExtensionTransactionPort(session));
              }),
            ),
          revert: controller.revert,
        };
        return children(bound) as never;
      }}
    </GenerationInputsDraft>
  );
}
