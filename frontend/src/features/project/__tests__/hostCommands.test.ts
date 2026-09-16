import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostCommandTable } from "../../../core/shell/commandTable";
import { HostContextKeyService } from "../../../core/shell/contextKeys";
import { projectPageActions } from "../services/ProjectPageActions";
import { installProjectHostCommands } from "../hostCommands";

const mocks = vi.hoisted(() => ({
  getRecents: vi.fn(),
  verifyPermission: vi.fn(),
  loadProject: vi.fn(),
  updateConfig: vi.fn(),
  config: { aspectRatio: "16:9", outputResolution: 1080 },
}));

vi.mock("../services/RecentProjectsService", () => ({
  recentProjectsService: { getRecents: mocks.getRecents },
}));

vi.mock("../services/FileSystemService", () => ({
  fileSystemService: { verifyPermission: mocks.verifyPermission },
}));

vi.mock("../useProjectStore", () => ({
  useProjectStore: Object.assign(vi.fn(), {
    getState: () => ({
      loadProject: mocks.loadProject,
      updateConfig: mocks.updateConfig,
      config: mocks.config,
    }),
  }),
}));

describe("project host commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyPermission.mockResolvedValue(true);
    mocks.loadProject.mockResolvedValue(undefined);
    mocks.config.aspectRatio = "16:9";
    mocks.config.outputResolution = 1080;
  });

  it("opens a recent project only through a user-dispatched command", async () => {
    const handle = {} as FileSystemDirectoryHandle;
    mocks.getRecents.mockResolvedValue([
      { id: "recent-1", name: "One", lastOpened: 1, handle },
    ]);
    const keys = new HostContextKeyService();
    keys.set("project.open", false);
    const table = new HostCommandTable(keys);
    const registration = installProjectHostCommands(table);

    expect(
      table.executeCommand("projects.open", {
        source: "menu",
        subject: { recentId: "recent-1" },
      }),
    ).toBe(true);
    await waitFor(() => expect(mocks.loadProject).toHaveBeenCalledWith(handle));
    expect(table.isHostExecuteAllowlisted("projects.open")).toBe(false);
    registration.dispose();
  });

  it("routes create to the mounted projects-page UI", () => {
    const handler = vi.fn();
    const pageRegistration = projectPageActions.setCreateHandler(handler);
    const keys = new HostContextKeyService();
    keys.set("project.open", false);
    const table = new HostCommandTable(keys);
    const registration = installProjectHostCommands(table);

    expect(
      table.executeCommand("projects.create", { source: "menu" }),
    ).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(table.isHostExecuteAllowlisted("projects.create")).toBe(false);

    registration.dispose();
    pageRegistration.dispose();
  });

  describe("project.set-output-resolution", () => {
    function openProjectTable() {
      const keys = new HostContextKeyService();
      keys.set("project.open", true);
      const table = new HostCommandTable(keys);
      return { table, registration: installProjectHostCommands(table) };
    }

    it.each([720, 768])("applies a valid short edge: %s", (outputResolution) => {
      const { table, registration } = openProjectTable();

      expect(
        table.executeCommand("project.set-output-resolution", {
          source: "menu",
          subject: { outputResolution },
        }),
      ).toBe(true);
      expect(mocks.updateConfig).toHaveBeenCalledWith({ outputResolution });

      registration.dispose();
    });

    it.each([
      ["a value below the minimum", 0],
      ["a numeric string", "720"],
      ["a missing value", undefined],
    ])("ignores %s", (_label, outputResolution) => {
      const { table, registration } = openProjectTable();

      table.executeCommand("project.set-output-resolution", {
        source: "menu",
        subject: outputResolution === undefined ? {} : { outputResolution },
      });
      expect(mocks.updateConfig).not.toHaveBeenCalled();

      registration.dispose();
    });

    it("ignores a short edge that makes the combined output too large", () => {
      mocks.config.aspectRatio = "4:1";
      const { table, registration } = openProjectTable();

      table.executeCommand("project.set-output-resolution", {
        source: "menu",
        subject: { outputResolution: 2160 },
      });
      expect(mocks.updateConfig).not.toHaveBeenCalled();

      registration.dispose();
    });
  });

  describe("project.set-aspect-ratio", () => {
    function openProjectTable() {
      const keys = new HostContextKeyService();
      keys.set("project.open", true);
      const table = new HostCommandTable(keys);
      return { table, registration: installProjectHostCommands(table) };
    }

    it.each([
      ["16:9", "16:9"],
      ["1344:768", "7:4"],
    ])("applies and canonicalizes %s", (aspectRatio, expected) => {
      const { table, registration } = openProjectTable();
      table.executeCommand("project.set-aspect-ratio", {
        source: "menu",
        subject: { aspectRatio },
      });
      expect(mocks.updateConfig).toHaveBeenCalledWith({
        aspectRatio: expected,
      });
      registration.dispose();
    });

    it.each(["0:4", "wide", "1:0", 1])("ignores invalid ratio %s", (aspectRatio) => {
      const { table, registration } = openProjectTable();
      table.executeCommand("project.set-aspect-ratio", {
        source: "menu",
        subject: { aspectRatio },
      });
      expect(mocks.updateConfig).not.toHaveBeenCalled();
      registration.dispose();
    });

    it("ignores a ratio that makes the combined output too large", () => {
      mocks.config.outputResolution = 2160;
      const { table, registration } = openProjectTable();

      table.executeCommand("project.set-aspect-ratio", {
        source: "menu",
        subject: { aspectRatio: "4:1" },
      });
      expect(mocks.updateConfig).not.toHaveBeenCalled();

      registration.dispose();
    });
  });
});
