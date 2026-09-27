/**
 * Heading anchors for workflow how-to documents.
 *
 * A how-to renders as several Markdown fragments (the document plus its
 * includes), so heading ids are assigned document-wide in a pure pre-pass:
 * GitHub-style slugs, deduplicated across every fragment so `[x](#tips)`
 * reaches the first "Tips" wherever it sits. Ids are prefixed so they cannot
 * collide with ids elsewhere in the app.
 */
import type { Element, Root as HastRoot, RootContent } from "hast";
import type { Root as MdastRoot, RootContent as MdastContent } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export const HOW_TO_HEADING_ID_PREFIX = "howto-";

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
// GitHub drops punctuation and symbols but keeps letters, marks, numbers,
// connector punctuation (`_`), hyphens and spaces.
const SLUG_STRIP_PATTERN = /[^\p{L}\p{M}\p{N}\p{Pc} -]/gu;

export function slugifyHeading(text: string): string {
  return text.trim().toLowerCase().replace(SLUG_STRIP_PATTERN, "").replace(/ /g, "-");
}

/** Returns a slug function that suffixes repeats (`tips`, `tips-1`, ...). */
export function createHeadingSlugger(): (text: string) => string {
  const used = new Set<string>();
  return (text) => {
    const base = slugifyHeading(text) || "section";
    let slug = base;
    for (let count = 1; used.has(slug); count += 1) {
      slug = `${base}-${count}`;
    }
    used.add(slug);
    return slug;
  };
}

const headingParser = unified().use(remarkParse).use(remarkGfm);

function collectHeadingTexts(node: MdastRoot | MdastContent, into: string[]) {
  if (node.type === "heading") {
    into.push(toString(node, { includeImageAlt: false }));
  }
  if ("children" in node) {
    for (const child of node.children) collectHeadingTexts(child, into);
  }
}

/**
 * Heading ids for each fragment, in document order. Fragments without
 * Markdown (e.g. missing includes) get an empty list.
 */
export function collectHowToHeadingIds(
  fragments: readonly (string | null)[],
): string[][] {
  const slug = createHeadingSlugger();
  return fragments.map((markdown) => {
    if (markdown === null) return [];
    const texts: string[] = [];
    collectHeadingTexts(headingParser.parse(markdown), texts);
    return texts.map((text) => `${HOW_TO_HEADING_ID_PREFIX}${slug(text)}`);
  });
}

/**
 * The element id an in-document link (`#Inputs`, `#caf%C3%A9`) points at,
 * or null for an empty or malformed fragment.
 */
export function howToAnchorTargetId(hash: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return null;
  }
  // Authors write the slug GitHub shows; slugify again so `#Inputs` works too.
  const slug = slugifyHeading(decoded);
  return slug ? `${HOW_TO_HEADING_ID_PREFIX}${slug}` : null;
}

/**
 * Rehype plugin assigning precomputed ids to headings in document order.
 * mdast headings and hast h1-h6 elements share that order, so the nth heading
 * gets the nth id; headings past the list (e.g. the GFM footnote label) keep
 * whatever id they already have.
 */
export function rehypeHowToHeadingIds(ids: readonly string[]) {
  return () => (tree: HastRoot) => {
    let index = 0;
    const visit = (node: HastRoot | RootContent) => {
      if (node.type === "element" && HEADING_TAGS.has(node.tagName)) {
        if (index < ids.length) {
          (node as Element).properties.id = ids[index];
        }
        index += 1;
      }
      if ("children" in node) {
        for (const child of node.children) visit(child);
      }
    };
    visit(tree);
  };
}
