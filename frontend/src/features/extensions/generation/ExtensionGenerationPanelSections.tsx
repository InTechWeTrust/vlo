import { createElement } from "react";
import { generationPanelSectionRegistry } from "../../generation/services/GenerationPanelSectionRegistry";
import type {
  ExtensionApiScope,
  ExtensionGenerationRegistration,
  ExtensionGenerationSectionDefinition,
} from "../types";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionDefinition,
} from "../registry/ExtensionContributionRegistry";
import { ExtensionGenerationPanelSectionMount } from "./ExtensionGenerationPanelSectionMount";

type GenerationPanelSectionContribution = ExtensionContributionDefinition &
  ExtensionGenerationSectionDefinition;

const extensionGenerationPanelSections =
  new ExtensionContributionRegistry<GenerationPanelSectionContribution>(
    "generation-panel-section",
  );

function validateDefinition(
  definition: ExtensionGenerationSectionDefinition,
): GenerationPanelSectionContribution {
  if (definition.apiVersion !== 1 || definition.kind !== "trusted-react") {
    throw new Error(
      `Generation section '${definition.id}' must use trusted-react API 1.`,
    );
  }
  if (typeof definition.component !== "function") {
    throw new Error(
      `Generation section '${definition.id}' must provide a component function.`,
    );
  }
  return { ...definition };
}

export function registerExtensionGenerationSection(
  scope: ExtensionApiScope,
  definition: ExtensionGenerationSectionDefinition,
): ExtensionGenerationRegistration {
  const validated = validateDefinition(definition);
  const contributionRegistration = extensionGenerationPanelSections
    .bind(scope)
    .register(validated);
  const contribution = contributionRegistration.contribution;

  let panelRegistration: ReturnType<
    typeof generationPanelSectionRegistry.register
  >;
  try {
    panelRegistration = generationPanelSectionRegistry.register({
      providerId: contribution.ownerId,
      contributionId: contribution.localId,
      render: (placement) =>
        createElement(ExtensionGenerationPanelSectionMount, {
          contributionId: contribution.id,
          component: contribution.definition.component,
          report: scope.report,
          placement,
        }),
    });
  } catch (error) {
    contributionRegistration.dispose();
    throw error;
  }

  const ownedPanelRegistration = scope.own(panelRegistration);
  return Object.freeze({
    id: contribution.id,
    dispose: () => {
      void ownedPanelRegistration.dispose();
      contributionRegistration.dispose();
    },
  });
}
