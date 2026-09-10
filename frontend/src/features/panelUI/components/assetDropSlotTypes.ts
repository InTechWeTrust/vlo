import type { Asset, AssetType } from "../../../types/Asset";

export interface AssetDropSlotValue {
  type: AssetType;
  name: string;
  thumbnail?: string;
  /**
   * Set while the slot's value is still being prepared (for example extracting
   * the audio track out of a dropped video) or when that preparation failed.
   */
  status?: "preparing" | "error";
  /** Shown in place of the name when `status` is set. */
  statusMessage?: string;
}

export interface AssetDropSlotReorderData {
  type: "media-input";
  /**
   * Which rendered surface the drag started on.
   *
   * Two surfaces can show the same input at once — a panel takeover does not
   * unmount the panel behind it — so the logical id alone cannot say whether a
   * drag came from *this* copy of a slot. Injected by the slot, which knows its
   * own surface; callers supply `inputId` and nothing else.
   */
  surfaceId: string;
  inputId: string;
}

/**
 * The half of {@link AssetDropSlotReorderData} a caller supplies.
 *
 * `surfaceId` is stamped on by the slot, which is the only thing that knows
 * which copy of itself is being dragged.
 */
export type AssetDropSlotReorderOrigin = Omit<
  AssetDropSlotReorderData,
  "surfaceId"
>;

/**
 * An action a slot can offer beyond dropping a library asset.
 *
 * Availability is otherwise modelled by callback presence, which has only two
 * states: offered, or absent entirely. A surface that *has* the action but
 * cannot perform it here — a staged editor, where a timeline capture or a file
 * upload starts real work it could not hold — needs a third: visible, refused,
 * and saying why. Handing such a surface a no-op callback would look enabled
 * and do nothing.
 */
export type AssetDropSlotAction =
  | "select"
  | "externalDrop"
  | "edit"
  | "reorder"
  /** Dragging an item in from a *different* media input, which swaps them. */
  | "crossInputReorder"
  /**
   * Emptying a filled slot. Refused where clearing would repack a batch the
   * host is holding open — the same condition the session reports as
   * `input_busy`.
   */
  | "clear"
  /**
   * Dropping onto an *occupied* position, which overwrites what is there.
   * Refused separately from a drop on a free one: overwriting repacks a batch
   * (remove, attach, reorder) while appending writes one free slot and leaves
   * the rest alone, so a busy batch can still take new items.
   */
  | "replace";

/** Actions this context refuses, each mapped to the reason shown to the user. */
export type AssetDropSlotDisabledActions = Partial<
  Record<AssetDropSlotAction, string>
>;

export interface AssetDropSlotProps {
  /**
   * The rendered surface this slot belongs to — `"panel"` for the generation
   * panel, a per-draft id for a staged editor.
   *
   * Required, deliberately. It namespaces the slot's drag registrations, and
   * two surfaces showing the same input register the same ids without it: the
   * second registration displaces the first, and unmounting the second removes
   * the entry outright, leaving the first mounted and unable to receive drops.
   * A default would reintroduce that the moment someone forgot.
   */
  surfaceId: string;
  /** Unique identifier for this slot */
  id: string;
  /** Which asset types this slot accepts */
  accept: AssetType[];
  /**
   * Additional per-asset allowance, checked when the asset's own type is not in
   * `accept` (for example a video carrying an audio track dropped on an audio
   * slot). Applies to library assets only; external file drops go by
   * `acceptExternal`.
   */
  acceptAsset?: (asset: Asset) => boolean;
  /**
   * Asset types accepted from an external (operating-system) file drop.
   * Defaults to `accept`. Widen it where a file's suitability can only be
   * judged after ingest — an audio slot takes video files, whose audio track
   * is extracted once the file is in the library.
   */
  acceptExternal?: AssetType[];
  /** Currently assigned asset */
  value?: AssetDropSlotValue | null;
  /** Callback to clear the assigned asset */
  onClear?: () => void;
  /** When provided and the slot is filled, shows a pencil button to edit the value. */
  onEdit?: () => void;
  /** Called when a compatible asset is dropped on this slot */
  onDrop?: (asset: Asset) => void;
  /** Called when a compatible external file is dropped on this slot */
  onExternalDrop?: (file: File) => void | Promise<void>;
  /** Called when the slot is clicked to select from timeline */
  onSelect?: () => void;
  /** Label shown above the slot */
  label?: string;
  /** Makes a filled slot draggable for media-input reordering */
  reorderData?: AssetDropSlotReorderOrigin | null;
  /** Called when a media-input slot is dropped onto this slot */
  onReorderDrop?: (data: AssetDropSlotReorderData) => void;
  /**
   * Whether a dragged media-input slot may land here. Consulted for the
   * highlight as well as the drop, so a refused source reads as incompatible
   * while it is being dragged rather than accepting and doing nothing.
   */
  acceptReorderFrom?: (data: AssetDropSlotReorderData) => boolean;
  /**
   * Actions to render as refused rather than absent, with the reason. An
   * action named here is inert even if its callback is supplied.
   */
  disabledActions?: AssetDropSlotDisabledActions;
}
