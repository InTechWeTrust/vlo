import type { Asset } from "../../../types/Asset";
import type { AssetFamily } from "../../../types/Asset";
import type {
  CompositeAsset,
  TimelineClip,
  TimelineTrack,
  Transition,
} from "../../../types/TimelineTypes";

export interface TimelineSnapshot {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  transitions?: Transition[];
}

export interface ProjectDocumentConfig {
  aspectRatio?: string;
  /**
   * Short edge in pixels. Absent in projects saved before it existed; the
   * loader validates the on-disk value before placing it in project state.
   */
  outputResolution?: number;
  fps?: number;
  fitMode?: "contain" | "cover";
  layoutMode?: "full-height" | "compact";
  assetBrowserDisplay?: "grouped" | "ungrouped";
}

export interface ProjectDocument {
  id?: string;
  title?: string;
  version?: string;
  schemaVersion?: number;
  createdWithVloVersion?: string;
  lastSavedWithVloVersion?: string;
  created_at?: number;
  last_modified?: number;
  config?: ProjectDocumentConfig;
  assets?: Record<string, Asset>;
  assetFamilies?: Record<string, AssetFamily>;
  composites?: Record<string, CompositeAsset>;
  timeline?: TimelineSnapshot;
  [key: string]: unknown;
}

export type {
  AssetIndexDocument,
  AssetMetadataDocument,
  CompositeLibraryDocument,
  CompositeSessionDocument,
  LegacyProjectDocument,
  PersistedCompositeSession,
  PersistedAssetIndexEntry,
  ProjectManifestDocument,
  TimelineDocument,
} from "../schemas/projectPersistenceSchemas";
