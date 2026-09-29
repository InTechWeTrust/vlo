import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ROOT_URL_REWRITE_DISABLE_KEY,
  installRootUrlRewrite,
  rewriteRootUrl,
} from "../../../../../../backend/assets/comfyui_bridge/root-url-rewrite.mjs";

const PAGE = "http://vlo.test/comfyui-frame/";

interface Recorded {
  self: unknown;
  args: unknown[];
}

function createWindow(href = PAGE, storage: Record<string, string> = {}) {
  const fetchCalls: Recorded[] = [];
  const xhrCalls: unknown[][] = [];
  const socketCalls: unknown[][] = [];
  const eventSourceCalls: unknown[][] = [];
  const beaconCalls: Recorded[] = [];

  class FakeXMLHttpRequest {
    open(...args: unknown[]) {
      xhrCalls.push(args);
    }
  }
  class FakeWebSocket {
    static readonly OPEN = 1;
    constructor(...args: unknown[]) {
      socketCalls.push(args);
    }
  }
  class FakeEventSource {
    static readonly CLOSED = 2;
    constructor(...args: unknown[]) {
      eventSourceCalls.push(args);
    }
  }

  const navigator = {
    sendBeacon(this: unknown, ...args: unknown[]) {
      beaconCalls.push({ self: this, args });
      return true;
    },
  };
  const windowObject = {
    location: new URL(href),
    localStorage: { getItem: (key: string) => storage[key] ?? null },
    fetch(this: unknown, ...args: unknown[]) {
      fetchCalls.push({ self: this, args });
      return Promise.resolve(new Response("ok"));
    },
    XMLHttpRequest: FakeXMLHttpRequest,
    WebSocket: FakeWebSocket,
    EventSource: FakeEventSource,
    navigator,
  };
  return {
    windowObject,
    originals: { FakeWebSocket, FakeEventSource, FakeXMLHttpRequest, navigator },
    fetchCalls,
    xhrCalls,
    socketCalls,
    eventSourceCalls,
    beaconCalls,
  };
}

const installed: Array<{ uninstall(): void }> = [];

function install(harness: ReturnType<typeof createWindow>, logger = { info: vi.fn() }) {
  const handle = installRootUrlRewrite({
    windowObject: harness.windowObject,
    logger,
  });
  if (handle) installed.push(handle);
  return handle;
}

afterEach(() => {
  while (installed.length) installed.pop()?.uninstall();
});

describe("rewriteRootUrl", () => {
  it.each([
    ["/ty_ltx_bridge/loras", "/comfyui-frame/ty_ltx_bridge/loras"],
    [
      "/editor_bridge/workflow/snapshot?id=1#top",
      "/comfyui-frame/editor_bridge/workflow/snapshot?id=1#top",
    ],
    ["/sd-ppp/?EIO=4", "/comfyui-frame/sd-ppp/?EIO=4"],
    ["/", "/comfyui-frame/"],
    // Judged by the path the browser requests, not the literal prefix.
    ["/comfyui-frame/../app/status", "/comfyui-frame/app/status"],
  ])("routes root-absolute %s through the frame prefix", (input, expected) => {
    expect(rewriteRootUrl(input)).toBe(expected);
  });

  it.each([
    "/comfyui-frame/api/prompt",
    "/comfyui-frame",
    "/comfyui-frame?view=1",
    "api/prompt",
    "",
    "http://vlo.test/app/status",
    "https://vlo.test/app/status",
    "http://127.0.0.1:8188/ty_ltx_bridge/loras",
    "//vlo.test/app/status",
    "//elsewhere.test/route",
    "/\\elsewhere.test/route",
    "ws://vlo.test/sd-ppp/",
    "blob:http://vlo.test/7c1d",
    "data:text/plain,hello",
  ])("leaves %s unchanged", (input) => {
    expect(rewriteRootUrl(input)).toBeNull();
  });

  it("leaves URL objects, Request objects and other inputs unchanged", () => {
    expect(rewriteRootUrl(new URL("http://vlo.test/app/status"))).toBeNull();
    expect(rewriteRootUrl(new Request("http://vlo.test/node/route"))).toBeNull();
    expect(rewriteRootUrl({})).toBeNull();
    expect(rewriteRootUrl(undefined)).toBeNull();
  });
});

describe("installRootUrlRewrite", () => {
  it("rewrites fetch URLs and calls the native fetch on the window", async () => {
    const harness = createWindow();
    install(harness);
    const init = { method: "POST", body: "{}" };

    const bareFetch = harness.windowObject.fetch;
    await bareFetch("/ty_ltx_bridge/loras", init);

    expect(harness.fetchCalls).toEqual([
      {
        self: harness.windowObject,
        args: ["/comfyui-frame/ty_ltx_bridge/loras", init],
      },
    ]);
  });

  it("passes full URLs and Request objects through untouched", async () => {
    const harness = createWindow();
    install(harness);
    const url = new URL("http://vlo.test/app/status");
    const request = new Request("http://vlo.test/node/route", {
      method: "POST",
      body: "x".repeat(1024),
    });

    await harness.windowObject.fetch(url);
    await harness.windowObject.fetch("http://vlo.test/app/status");
    await harness.windowObject.fetch(request);

    expect(harness.fetchCalls.map(({ args }) => args)).toEqual([
      [url],
      ["http://vlo.test/app/status"],
      [request],
    ]);
    expect(harness.fetchCalls[2].args[0]).toBe(request);
    expect(request.bodyUsed).toBe(false);
  });

  it("keeps XMLHttpRequest.open arity so async stays the default", () => {
    const harness = createWindow();
    install(harness);

    new harness.windowObject.XMLHttpRequest().open("POST", "/node/route");
    new harness.windowObject.XMLHttpRequest().open("GET", "/node/route", false);

    expect(harness.xhrCalls).toEqual([
      ["POST", "/comfyui-frame/node/route"],
      ["GET", "/comfyui-frame/node/route", false],
    ]);
  });

  it("subclasses WebSocket and EventSource without losing their shape", () => {
    const harness = createWindow();
    install(harness);
    const { FakeWebSocket, FakeEventSource } = harness.originals;
    const { WebSocket, EventSource } = harness.windowObject;

    const socket = new WebSocket("/sd-ppp/?EIO=4", ["chat"]);
    new WebSocket("ws://vlo.test/comfyui-frame/ws");
    new EventSource("/node/events", { withCredentials: true });

    expect(harness.socketCalls).toEqual([
      ["/comfyui-frame/sd-ppp/?EIO=4", ["chat"]],
      ["ws://vlo.test/comfyui-frame/ws"],
    ]);
    expect(harness.eventSourceCalls).toEqual([
      ["/comfyui-frame/node/events", { withCredentials: true }],
    ]);
    expect(socket).toBeInstanceOf(FakeWebSocket);
    expect(WebSocket.OPEN).toBe(1);
    expect(WebSocket.name).toBe("WebSocket");
    expect(EventSource.CLOSED).toBe(FakeEventSource.CLOSED);
  });

  it("rewrites sendBeacon and keeps navigator as its receiver", () => {
    const harness = createWindow();
    install(harness);

    const { sendBeacon } = harness.windowObject.navigator;
    sendBeacon("/editor_bridge/workflow/snapshot", "{}");

    expect(harness.beaconCalls).toEqual([
      {
        self: harness.originals.navigator,
        args: ["/comfyui-frame/editor_bridge/workflow/snapshot", "{}"],
      },
    ]);
  });

  it("logs once per rewritten root path", async () => {
    const harness = createWindow();
    const logger = { info: vi.fn() };
    install(harness, logger);

    await harness.windowObject.fetch("/ty_ltx_bridge/loras");
    await harness.windowObject.fetch("/ty_ltx_bridge?x=1");
    await harness.windowObject.fetch("/editor_bridge/workflow/snapshot");

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info.mock.calls[0][0]).toContain("/ty_ltx_bridge requests");
    expect(logger.info.mock.calls[1][0]).toContain("/editor_bridge requests");
  });

  it("installs once, only under the prefix, and not when switched off", () => {
    const harness = createWindow();
    expect(install(harness)).not.toBeNull();
    expect(install(harness)).toBeNull();

    expect(install(createWindow("http://vlo.test/"))).toBeNull();
    expect(
      install(createWindow(PAGE, { [ROOT_URL_REWRITE_DISABLE_KEY]: "off" })),
    ).toBeNull();
  });

  it("restores every wrapped API on uninstall", () => {
    const harness = createWindow();
    const before = {
      fetch: harness.windowObject.fetch,
      open: harness.originals.FakeXMLHttpRequest.prototype.open,
      sendBeacon: harness.originals.navigator.sendBeacon,
    };

    installRootUrlRewrite({ windowObject: harness.windowObject })?.uninstall();

    expect(harness.windowObject.fetch).toBe(before.fetch);
    expect(harness.originals.FakeXMLHttpRequest.prototype.open).toBe(before.open);
    expect(harness.windowObject.navigator.sendBeacon).toBe(before.sendBeacon);
    expect(harness.windowObject.WebSocket).toBe(harness.originals.FakeWebSocket);
    expect(harness.windowObject.EventSource).toBe(harness.originals.FakeEventSource);
  });
});
