export { ProjectManager } from "./components/ProjectManager";
export { ProjectTitle } from "./components/ProjectTitle";
export { installProjectHostCommands } from "./hostCommands";
export { useProjectStore } from "./useProjectStore";
export { fileSystemService } from "./services/FileSystemService";
export { projectDocumentService } from "./services/ProjectDocumentService";
export {
  projectPersistenceService,
  prepareAssetForPersistence,
} from "./services/ProjectPersistenceService";
export {
  projectTrashService,
  PROJECT_TRASH_LIMIT_BYTES,
} from "./services/ProjectTrashService";
export {
  PROJECT_ASPECT_RATIOS,
  isPresetAspectRatio,
} from "./aspectRatioOptions";
export type {
  AspectRatio,
  PresetAspectRatio,
} from "./aspectRatioOptions";
export { collectTimelineExtensionRequirements } from "./utils/extensionRequirements";
export type {
  ProjectState,
  ProjectConfig,
  AssetBrowserDisplay,
  ProjectFitMode,
  ProjectTimelineSnapshotRequest,
} from "./useProjectStore";
export type {
  AssetIndexDocument,
  AssetMetadataDocument,
  CompositeLibraryDocument,
  CompositeSessionDocument,
  PersistedAssetIndexEntry,
  PersistedCompositeSession,
  ProjectDocument,
  ProjectManifestDocument,
  TimelineDocument,
  TimelineSnapshot,
} from "./types/ProjectDocument";
