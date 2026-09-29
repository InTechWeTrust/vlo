import { startVloBridge } from "./bridge-core.mjs";
import { installRootUrlRewrite } from "./root-url-rewrite.mjs";

const SINGLETON_KEY = Symbol.for("vlo.bridge.runtime.v2");
const STARTING_KEY = Symbol.for("vlo.bridge.runtime.starting.v1");
const COMFY_API_POLL_MS = 50;

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function startWhenComfyApiIsReady() {
  while (!window.comfyAPI?.app?.app || !window.comfyAPI?.api?.api) {
    await sleep(COMFY_API_POLL_MS);
  }
  if (window[SINGLETON_KEY]) return;
  window[SINGLETON_KEY] = startVloBridge({
    app: window.comfyAPI.app.app,
    api: window.comfyAPI.api.api,
    windowObject: window,
  });
}

// Installed synchronously as this module evaluates. The backend injects this
// module's tag first in <head>, so the wrap is in place before ComfyUI sets up
// its app and before any custom-node extension loads.
installRootUrlRewrite({ windowObject: window });

if (!window[SINGLETON_KEY] && !window[STARTING_KEY]) {
  window[STARTING_KEY] = true;
  void startWhenComfyApiIsReady().finally(() => {
    delete window[STARTING_KEY];
  });
}
