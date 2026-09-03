import { useMemo, type ComponentType } from "react";
import type { GenerationPanelSectionPlacement } from "../../generation/services/GenerationPanelSectionRegistry";
import { GENERATION_PANEL_SECTION_LIMITS } from "../../generation/services/GenerationPanelSectionRegistry";
import { cloneFrozenJsonObject } from "../registry/frozenJson";
import type {
  ExtensionApiScope,
  ExtensionGenerationSectionDefinition,
  ExtensionGenerationSectionProps,
} from "../types";
import { ExtensionTrustedReactMount } from "../ui/ExtensionTrustedReactMount";

interface ExtensionGenerationPanelSectionMountProps {
  readonly contributionId: string;
  readonly component: ExtensionGenerationSectionDefinition["component"];
  readonly report: ExtensionApiScope["report"];
  readonly placement: GenerationPanelSectionPlacement;
}

type ExtensionGenerationPanelSectionBodyProps = Omit<
  ExtensionGenerationPanelSectionMountProps,
  "report"
>;

function ExtensionGenerationPanelSectionBody({
  contributionId,
  component,
  placement,
}: ExtensionGenerationPanelSectionBodyProps) {
  const config = useMemo(
    () => {
      const cloned = cloneFrozenJsonObject(
        placement.config,
        `Generation section '${contributionId}' workflow config`,
      );
      if (
        JSON.stringify(cloned).length >
        GENERATION_PANEL_SECTION_LIMITS.configLength
      ) {
        throw new Error(
          `Generation section '${contributionId}' workflow config exceeds ${GENERATION_PANEL_SECTION_LIMITS.configLength} serialized characters.`,
        );
      }
      return cloned;
    },
    [contributionId, placement.config],
  );
  const componentProps = useMemo<ExtensionGenerationSectionProps>(
    () =>
      Object.freeze({
        placementId: placement.placementId,
        sectionId: placement.sectionId,
        active: placement.active,
        config,
      }),
    [config, placement.active, placement.placementId, placement.sectionId],
  );

  const TrustedComponent = component as ComponentType<ExtensionGenerationSectionProps>;
  return <TrustedComponent {...componentProps} />;
}

export function ExtensionGenerationPanelSectionMount({
  contributionId,
  component,
  report,
  placement,
}: ExtensionGenerationPanelSectionMountProps) {
  return (
    <ExtensionTrustedReactMount
      contributionId={contributionId}
      surface="Generation panel section"
      report={report}
      component={ExtensionGenerationPanelSectionBody}
      componentProps={{ contributionId, component, placement }}
    />
  );
}
