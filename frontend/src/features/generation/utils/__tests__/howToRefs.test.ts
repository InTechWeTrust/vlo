import { describe, expect, it } from "vitest";
import { resolveHowToRef, type HowToAssetUrls } from "../howToRefs";

const urls: HowToAssetUrls = {
  bundleAsset: (path) => `/bundle/${path}`,
  sharedAsset: (path) => `/shared/${path}`,
};

describe("resolveHowToRef", () => {
  it("resolves relative refs inside the bundle", () => {
    expect(resolveHowToRef("assets/shot.png", "bundle:", urls)).toEqual({
      kind: "asset",
      url: "/bundle/assets/shot.png",
      isVideo: false,
    });
    expect(resolveHowToRef("../clip.webm", "bundle:docs/", urls)).toEqual({
      kind: "asset",
      url: "/bundle/clip.webm",
      isVideo: true,
    });
  });

  it("resolves an included shared doc's refs inside its own library", () => {
    expect(resolveHowToRef("mask.webp", "shared:inpainting/", urls)).toEqual({
      kind: "asset",
      url: "/shared/inpainting/mask.webp",
      isVideo: false,
    });
  });

  it("resolves shared: refs from any document, including loose ones", () => {
    expect(resolveHowToRef("shared:inpainting/demo.MP4", null, urls)).toEqual({
      kind: "asset",
      url: "/shared/inpainting/demo.MP4",
      isVideo: true,
    });
  });

  it("decodes Markdown's percent-encoding once so URLs are encoded once", () => {
    // Markdown turns `<assets/my shot.png>` into `assets/my%20shot.png`.
    expect(resolveHowToRef("assets/my%20shot.png", "bundle:", urls)).toMatchObject({
      url: "/bundle/assets/my shot.png",
    });
    expect(resolveHowToRef("caf%C3%A9.webm", "shared:lib/", urls)).toEqual({
      kind: "asset",
      url: "/shared/lib/café.webm",
      isVideo: true,
    });
    expect(resolveHowToRef("a/%2e%2e/b.png", "bundle:", urls)).toMatchObject({
      url: "/bundle/b.png",
    });
  });

  it("keeps the backend-supplied base directory as-is", () => {
    expect(resolveHowToRef("x.png", "bundle:dir%20name/", urls)).toMatchObject({
      url: "/bundle/dir%20name/x.png",
    });
  });

  it("drops query strings and hashes from asset paths", () => {
    expect(resolveHowToRef("a.png?v=2#x", "bundle:", urls)).toMatchObject({
      url: "/bundle/a.png",
    });
  });

  it.each([
    ["../escape.png", "bundle:"],
    ["../../escape.png", "bundle:docs/"],
    ["shared:../escape.png", "bundle:"],
    ["/etc/passwd", "bundle:"],
    ["a\\b.png", "bundle:"],
    [".hidden/a.png", "bundle:"],
    ["a//b.png", "bundle:"],
    ["relative.png", null],
    ["javascript:alert(1)", "bundle:"],
    ["data:image/png;base64,AAAA", "bundle:"],
    ["file:///etc/passwd", "bundle:"],
    ["", "bundle:"],
    ["a%2Fb.png", "bundle:"],
    ["a%5Cb.png", "bundle:"],
    ["a%00.png", "bundle:"],
    ["%ZZ.png", "bundle:"],
    ["%2e%2e/escape.png", "bundle:"],
    ["%2ehidden.png", "bundle:"],
    ["shared:%2e%2e/escape.png", null],
  ])("refuses %s (base %s)", (ref, base) => {
    expect(resolveHowToRef(ref, base, urls).kind).toBe("unresolved");
  });

  it("passes web links and in-page anchors through", () => {
    expect(resolveHowToRef("https://example.com/x", "bundle:", urls)).toEqual({
      kind: "external",
      url: "https://example.com/x",
    });
    expect(resolveHowToRef("mailto:a@b.c", null, urls).kind).toBe("external");
    expect(resolveHowToRef("#inputs", null, urls)).toEqual({
      kind: "anchor",
      url: "#inputs",
      targetId: "howto-inputs",
    });
    expect(resolveHowToRef("#%ZZ", null, urls).kind).toBe("unresolved");
  });
});
