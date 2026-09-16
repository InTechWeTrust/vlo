import { describe, expect, it } from "vitest";
import {
  getProjectOutputGeometryError,
  resolveProjectOutputDimensions,
} from "../projectOutputGeometry";

describe("project output geometry", () => {
  it("uses the same even dimensions as rendering", () => {
    expect(resolveProjectOutputDimensions("7:4", 768)).toEqual({
      width: 1344,
      height: 768,
    });
    expect(resolveProjectOutputDimensions("9:16", 832)).toEqual({
      width: 832,
      height: 1480,
    });
  });

  it("accepts the previous largest preset output", () => {
    expect(getProjectOutputGeometryError("16:9", 2160)).toBeNull();
  });

  it("rejects an output whose long edge exceeds 8192px", () => {
    expect(getProjectOutputGeometryError("4:1", 2160)).toContain(
      "8192px maximum edge",
    );
  });

  it("rejects an output larger than the previous maximum pixel area", () => {
    expect(getProjectOutputGeometryError("1:1", 4000)).toContain(
      "maximum output area",
    );
  });
});
