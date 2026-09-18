/** Host progress shared by native and SDK-triggered render jobs. */
export type ExportPhase =
  | "preparing"
  | "audio"
  | "rendering"
  | "finalizing"
  | "saving"
  | "ingesting"
  | "cancelling";
