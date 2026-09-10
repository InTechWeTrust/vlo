import { describe, expect, it } from "vitest";

import { acceptsReorderDrag } from "../assetDropSlotUtils";
import type { AssetDropSlotReorderData } from "../assetDropSlotTypes";

const FROM: AssetDropSlotReorderData = {
  type: "media-input",
  surfaceId: "panel",
  inputId: "142:files::repeat::0",
};

/**
 * The highlight and the drop have to reach the same verdict.
 *
 * They were decided separately in `AssetDropSlot` and `AssetBatchDropSlot` and
 * drifted: the batch strip consulted neither the caller's rule nor its own
 * refusal, so a drag it would turn away lit up as a valid target and then did
 * nothing when dropped. Both now ask this.
 */
describe("acceptsReorderDrag", () => {
  it("accepts a drag the slot's own rule admits", () => {
    expect(
      acceptsReorderDrag({
        refused: false,
        hasHandler: true,
        accept: () => true,
        from: FROM,
      }),
    ).toBe(true);
  });

  it("accepts a drag when the slot states no rule of its own", () => {
    expect(
      acceptsReorderDrag({
        refused: false,
        hasHandler: true,
        accept: undefined,
        from: FROM,
      }),
    ).toBe(true);
  });

  it("refuses a drag the slot's rule rejects", () => {
    // Where the surface and cross-input checks land: a drag from another
    // surface, or another input, comes back false.
    expect(
      acceptsReorderDrag({
        refused: false,
        hasHandler: true,
        accept: (data) => data.surfaceId === "panel" && data.inputId === "x",
        from: FROM,
      }),
    ).toBe(false);
  });

  it("refuses a drag while the slot refuses reordering", () => {
    // A refused reorder leaves the drop handler undefined, so showing this as
    // a valid target would promise something nothing would carry out.
    expect(
      acceptsReorderDrag({
        refused: true,
        hasHandler: true,
        accept: () => true,
        from: FROM,
      }),
    ).toBe(false);
  });

  it("refuses a drag on a slot that does not reorder at all", () => {
    expect(
      acceptsReorderDrag({
        refused: false,
        hasHandler: false,
        accept: () => true,
        from: FROM,
      }),
    ).toBe(false);
  });
});
