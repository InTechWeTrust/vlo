import ts from "typescript";
import { expect, it } from "vitest";

const sources = import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

it("constructs versioned timeline selections only in the timing boundary", () => {
  const violations: string[] = [];
  for (const [path, source] of Object.entries(sources)) {
    if (path.includes("__tests__") || path.includes(".test.") || path.includes("/timeline/time/")) continue;
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if (ts.isObjectLiteralExpression(node)) {
        const names = node.properties.flatMap((property) => property.name ? [property.name.getText(file)] : []);
        if (names.includes("version") && names.includes("anchor") && names.includes("region")) violations.push(path);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  expect(violations).toEqual([]);
});
