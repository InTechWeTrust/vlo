import { describe, expect, it } from "vitest";
import { projectMenuTreeGroups } from "../menuTreePresentation";
import { type MenuTreeLayout } from "../menuTree";

const layout: MenuTreeLayout = {
  nodes: [{ id: "custom", kind: "category", label: "Owner folder", parentId: null, order: 0 }],
  leafPlacements: [
    { leafId: "one", parentId: "custom", order: 7 },
    { leafId: "two", parentId: "custom", order: 9 },
    { leafId: "retired", parentId: null, order: 1 },
  ],
};

describe("menu presentation grouping", () => {
  it("keeps source layout and one registered ID per workflow while grouping mixed saved folders", () => {
    const before = JSON.stringify(layout);
    const result = projectMenuTreeGroups(layout, [
      { id: "active", label: "Active", leafIds: ["one"] },
      { id: "lab", label: "Lab", leafIds: ["two"] },
    ]);
    expect(JSON.stringify(layout)).toBe(before);
    expect(result.leafPlacements).toEqual([
      { leafId: "one", parentId: "presentation/active/custom", order: 7 },
      { leafId: "two", parentId: "presentation/lab/custom", order: 9 },
    ]);
    expect(result.leafPlacements.some((item) => item.leafId === "retired")).toBe(false);
  });
  it("refuses duplicate or unknown ownership and invalid source group IDs", () => {
    expect(() => projectMenuTreeGroups(layout, [{ id: "x", label: "X", leafIds: ["one", "one"] }])).toThrow();
    expect(() => projectMenuTreeGroups(layout, [{ id: "x", label: "X", leafIds: ["unknown"] }])).toThrow();
    expect(() => projectMenuTreeGroups(layout, [{ id: "x x", label: "X", leafIds: ["one"] }])).toThrow();
  });
});
