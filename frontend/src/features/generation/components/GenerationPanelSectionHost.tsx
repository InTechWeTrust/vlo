import { useMemo, useSyncExternalStore } from "react";
import { Alert } from "@mui/material";
import { useFrontendExtensionActivationStatus } from "../../extensions/components/frontendExtensionActivationContext";
import { usePanelSectionActive } from "../../panelUI";
import { serializeFiniteJson } from "../utils/finiteJson";
import type { WorkflowExtensionSection } from "../services/workflowRules";
import {
  GENERATION_PANEL_SECTION_LIMITS,
  generationPanelSectionRegistry,
} from "../services/GenerationPanelSectionRegistry";

const EMPTY_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({});
const subscribeToGenerationPanelSections = (listener: () => void) =>
  generationPanelSectionRegistry.subscribe(listener);
const readGenerationPanelSectionRevision = () =>
  generationPanelSectionRegistry.getRevision();

interface GenerationPanelSectionHostProps {
  readonly placementId: string;
  readonly sectionId: string;
  readonly workflowId: string | null;
  readonly extension: WorkflowExtensionSection;
}

export function GenerationPanelSectionHost({
  placementId,
  sectionId,
  workflowId,
  extension,
}: GenerationPanelSectionHostProps) {
  useSyncExternalStore(
    subscribeToGenerationPanelSections,
    readGenerationPanelSectionRevision,
    readGenerationPanelSectionRevision,
  );
  const activationStatus = useFrontendExtensionActivationStatus();
  const active = usePanelSectionActive();
  const rawConfig = extension.config ?? EMPTY_CONFIG;
  const serializedConfig = useMemo(
    () => serializeFiniteJson(rawConfig),
    [rawConfig],
  );
  const config = useMemo<Readonly<Record<string, unknown>> | null>(() => {
    if (
      serializedConfig === null ||
      serializedConfig.length > GENERATION_PANEL_SECTION_LIMITS.configLength
    ) {
      return null;
    }
    const parsed = JSON.parse(serializedConfig) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  }, [serializedConfig]);

  if (serializedConfig === null) {
    return (
      <Alert severity="error">
        Generation control {extension.extension_id}/
        {extension.contribution_id} has workflow config that is not a finite JSON
        object.
      </Alert>
    );
  }
  if (serializedConfig.length > GENERATION_PANEL_SECTION_LIMITS.configLength) {
    return (
      <Alert severity="error">
        Generation control {extension.extension_id}/
        {extension.contribution_id} has workflow config larger than {" "}
        {GENERATION_PANEL_SECTION_LIMITS.configLength} serialized characters.
      </Alert>
    );
  }
  if (config === null) {
    return (
      <Alert severity="error">
        Generation control {extension.extension_id}/
        {extension.contribution_id} has workflow config that is not a JSON object.
      </Alert>
    );
  }

  const provider = generationPanelSectionRegistry.get(
    extension.extension_id,
    extension.contribution_id,
  );
  if (!provider) {
    if (activationStatus === "pending") return null;
    return (
      <Alert severity="warning">
        This workflow requires generation control {extension.extension_id}/
        {extension.contribution_id}, but that provider is not active.
      </Alert>
    );
  }

  return provider.render({
    placementId,
    sectionId,
    workflowId,
    active,
    config,
  });
}
