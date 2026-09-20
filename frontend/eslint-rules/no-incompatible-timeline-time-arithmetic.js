import ts from "typescript";

const TIME_DOMAIN_PROPERTY = "__timelineTimeDomain";
const CHECKED_OPERATORS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "!=",
  "===",
  "!==",
]);

function getLiteralDomain(checker, type, location) {
  if (type.isUnion()) {
    const domains = new Set(
      type.types
        .map((member) => getLiteralDomain(checker, member, location))
        .filter(Boolean),
    );
    return domains.size === 1 ? [...domains][0] : null;
  }

  const property = checker.getPropertyOfType(type, TIME_DOMAIN_PROPERTY);
  if (!property) return null;
  const declaration = property.valueDeclaration ?? property.declarations?.[0];
  const propertyType = checker.getTypeOfSymbolAtLocation(
    property,
    declaration ?? location,
  );
  const members = propertyType.isUnion() ? propertyType.types : [propertyType];
  const literals = members.filter((member) => member.flags & ts.TypeFlags.StringLiteral);
  return literals.length === 1 ? literals[0].value : null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow arithmetic and comparisons between incompatible timeline time domains",
    },
    schema: [{ type: "object", properties: { lenient: { type: "boolean" } }, additionalProperties: false }],
    messages: {
      incompatible:
        "Do not apply '{{operator}}' to {{leftDomain}} and {{rightDomain}} timeline values. Convert through TimelineTime.",
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) {
      throw new Error(
        "no-incompatible-timeline-time-arithmetic requires type-aware parser services",
      );
    }
    const checker = services.program.getTypeChecker();

    const lenient = context.options[0]?.lenient === true;
    // Arithmetic has TypeScript type `number`; retain its clock through local
    // aliases so `const end = clip.start + clip.timelineDuration` stays stored.
    const inferDomain = (node, seen = new Set()) => {
      if (!node || seen.has(node)) return null;
      seen.add(node);
      const explicit = getLiteralDomain(checker, checker.getTypeAtLocation(node), node);
      if (explicit) return explicit;
      if (ts.isParenthesizedExpression(node)) return inferDomain(node.expression, seen);
      if (ts.isIdentifier(node)) {
        const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
        if (declaration && ts.isVariableDeclaration(declaration) && !declaration.type) {
          return inferDomain(declaration.initializer, seen);
        }
      }
      if (ts.isBinaryExpression(node)) {
        const left = inferDomain(node.left, seen);
        const right = inferDomain(node.right, seen);
        const operator = node.operatorToken.kind;
        if (operator === ts.SyntaxKind.MinusToken && left && left === right) return "duration";
        if (operator !== ts.SyntaxKind.PlusToken && operator !== ts.SyntaxKind.MinusToken) return null;
        if (left && (!right || right === "duration")) return left;
        if (right && (!left || left === "duration") && operator === ts.SyntaxKind.PlusToken) return right;
      }
      return null;
    };
    const domainOf = (node) => inferDomain(services.esTreeNodeToTSNodeMap.get(node));
    const compatible = (left, right) => left === right ||
      (lenient && (!left || !right || left === "duration" || right === "duration"));

    return {
      CallExpression(node) {
        const callee = node.callee;
        const checked = (callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" && callee.object.name === "Math" &&
          callee.property.type === "Identifier" && ["min", "max"].includes(callee.property.name)) ||
          (callee.type === "Identifier" && /clamp/i.test(callee.name));
        if (!checked) return;
        const args = node.arguments.filter((arg) => arg.type !== "SpreadElement");
        for (let i = 0; i < args.length; i++) {
          for (let j = i + 1; j < args.length; j++) {
            const left = domainOf(args[i]);
            const right = domainOf(args[j]);
            if ((!left && !right) || compatible(left, right)) continue;
            context.report({ node, messageId: "incompatible", data: {
              operator: "clamp/min/max", leftDomain: left ?? "untyped-number", rightDomain: right ?? "untyped-number",
            }});
            return;
          }
        }
      },
      BinaryExpression(node) {
        if (!CHECKED_OPERATORS.has(node.operator)) return;
        const leftDomain = domainOf(node.left);
        const rightDomain = domainOf(node.right);
        if (!leftDomain && !rightDomain) return;
        if (
          (node.left.type === "Literal" && node.left.value === null) ||
          (node.right.type === "Literal" && node.right.value === null)
        ) {
          return;
        }
        if (compatible(leftDomain, rightDomain)) return;

        context.report({
          node,
          messageId: "incompatible",
          data: {
            operator: node.operator,
            leftDomain: leftDomain ?? "untyped-number",
            rightDomain: rightDomain ?? "untyped-number",
          },
        });
      },
    };
  },
};
