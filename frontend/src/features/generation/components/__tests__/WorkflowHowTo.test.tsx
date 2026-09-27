import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorkflowHowToButton } from "../WorkflowHowTo";

const fetchMock = vi.fn();
// jsdom has no scrollIntoView; the anchor test installs a spy.
const originalScrollIntoView = Element.prototype.scrollIntoView;

function respondWith(body: unknown, ok = true) {
  fetchMock.mockResolvedValueOnce({
    ok,
    status: ok ? 200 : 404,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

async function openHowTo() {
  render(<WorkflowHowToButton workflowId="wf.json" workflowLabel="My Workflow" />);
  fireEvent.click(screen.getByRole("button", { name: "How to use this workflow" }));
  return screen.findByRole("dialog");
}

describe("WorkflowHowToButton", () => {
  it("renders bundle and shared fragments with resolved media", async () => {
    respondWith({
      workflow_id: "wf.json",
      fragments: [
        {
          kind: "markdown",
          markdown: "# Getting started\n\n![Shot](assets/shot.png)\n",
          base: "bundle:",
        },
        {
          kind: "markdown",
          markdown: "![Demo](demo.webm)\n",
          base: "shared:inpainting/",
        },
        { kind: "missing", src: "shared:lib/gone.md", reason: "not_found" },
      ],
    });

    const dialog = await openHowTo();

    expect(fetchMock.mock.calls[0][0]).toContain("/comfy/workflow/howto/wf.json");
    expect(
      await screen.findByRole("heading", { name: "Getting started" }),
    ).toBeInTheDocument();
    expect(screen.getByText("How to use My Workflow")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Shot" })).toHaveAttribute(
      "src",
      expect.stringMatching(/\/comfy\/workflow\/howto\/wf\.json\/assets\/assets\/shot\.png$/),
    );
    const video = dialog.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toMatch(
      /\/comfy\/workflow\/shared\/inpainting\/demo\.webm$/,
    );
    expect(screen.getByText("shared:lib/gone.md")).toBeInTheDocument();
  });

  it("encodes asset paths with spaces exactly once", async () => {
    respondWith({
      workflow_id: "wf.json",
      fragments: [
        {
          kind: "markdown",
          markdown: "![Spaced](<assets/my shot.png>)\n",
          base: "bundle:",
        },
      ],
    });

    await openHowTo();

    const image = await screen.findByRole("img", { name: "Spaced" });
    expect(image.getAttribute("src")).toMatch(/\/assets\/assets\/my%20shot\.png$/);
  });

  it("gives headings ids and scrolls to them from section links", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const hashBefore = window.location.hash;
    respondWith({
      workflow_id: "wf.json",
      fragments: [
        {
          kind: "markdown",
          markdown: "# Guide\n\nSee [crop mode](#mask-crop-mode).\n\n## Tips\n",
          base: "bundle:",
        },
        {
          kind: "markdown",
          markdown: "## Mask crop mode\n\n## Tips\n",
          base: "shared:inpainting/",
        },
      ],
    });

    await openHowTo();

    const target = await screen.findByRole("heading", { name: "Mask crop mode" });
    expect(target).toHaveAttribute("id", "howto-mask-crop-mode");
    const tips = screen.getAllByRole("heading", { name: "Tips" });
    expect(tips.map((heading) => heading.id)).toEqual([
      "howto-tips",
      "howto-tips-1",
    ]);

    fireEvent.click(screen.getByRole("link", { name: "crop mode" }));

    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView.mock.contexts[0]).toBe(target);
    expect(window.location.hash).toBe(hashBefore);
  });

  it("links remote media instead of embedding it and refuses unsafe links", async () => {
    respondWith({
      workflow_id: "wf.json",
      fragments: [
        {
          kind: "markdown",
          markdown:
            "![Remote](https://example.com/a.png)\n\n" +
            "[bad](javascript:alert(1)) [docs](https://example.com/docs)\n\n" +
            "<img src=x onerror=alert(1)>\n",
          base: "bundle:",
        },
      ],
    });

    const dialog = await openHowTo();

    const remote = await screen.findByRole("link", { name: "Remote" });
    expect(remote).toHaveAttribute("href", "https://example.com/a.png");
    expect(remote).toHaveAttribute("target", "_blank");
    expect(dialog.querySelectorAll("img")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(screen.getByText("bad")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
  });

  it("shows an error when the how-to cannot be loaded", async () => {
    respondWith(
      { error: { code: "workflow_how_to_not_found", message: "Workflow has no how-to" } },
      false,
    );

    await openHowTo();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("closes from the close button", async () => {
    respondWith({ workflow_id: "wf.json", fragments: [] });

    await openHowTo();
    fireEvent.click(screen.getByRole("button", { name: "Close how-to" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
