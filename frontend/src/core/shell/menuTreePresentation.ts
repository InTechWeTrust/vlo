import { assertMenuTreeLayout, type MenuTreeLayout } from "./menuTree";

/** Source-owned presentation; saved folders and placements remain independent. */
export interface MenuTreePresentationGroup {
  readonly id: string;
  readonly label: string;
  readonly leafIds: readonly string[];
}

export function projectMenuTreeGroups(
  layout: MenuTreeLayout,
  groups: readonly MenuTreePresentationGroup[],
): MenuTreeLayout {
  assertMenuTreeLayout(layout);
  const groupIds = new Set<string>();
  const seenLeaves = new Set<string>();
  const placements = new Map(layout.leafPlacements.map((item) => [item.leafId, item]));
  const nodes: MenuTreeLayout["nodes"][number][] = [];
  const leafPlacements: MenuTreeLayout["leafPlacements"][number][] = [];
  groups.forEach((group, order) => {
    if (groupIds.has(group.id)) throw new Error("Duplicate presentation group");
    groupIds.add(group.id);
    const prefix = `presentation/${group.id}`;
    nodes.push({ id: prefix, kind: "category", label: group.label, parentId: null, order });
    for (const node of layout.nodes) {
      nodes.push({ ...node, id: `${prefix}/${node.id}`, kind: "folder",
        parentId: node.parentId === null ? prefix : `${prefix}/${node.parentId}` });
    }
    for (const leafId of group.leafIds) {
      const original = placements.get(leafId);
      if (!original || seenLeaves.has(leafId)) throw new Error("Invalid presentation leaf membership");
      seenLeaves.add(leafId);
      leafPlacements.push({ ...original,
        parentId: original.parentId === null ? prefix : `${prefix}/${original.parentId}` });
    }
  });
  const result = { nodes, leafPlacements };
  assertMenuTreeLayout(result);
  return result;
}
