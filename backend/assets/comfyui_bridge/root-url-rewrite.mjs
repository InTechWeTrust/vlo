// Route root-absolute requests made inside the ComfyUI iframe back to ComfyUI.
//
// ComfyUI's own frontend derives every URL from the page path, so it works
// under /comfyui-frame. Custom nodes often hard-code root paths instead
// (fetch("/my_node/route")), which works when ComfyUI owns the origin but
// lands on vlo's own routes here. This shim prefixes those paths with
// /comfyui-frame, where the backend and the Vite dev server already forward
// everything to ComfyUI.
//
// Only root-relative strings are rewritten. Full URLs, protocol-relative
// URLs, URL objects and Request objects go out unchanged, so a request that
// names its target explicitly is never redirected.
//
// It is a compatibility shim, not a security boundary: code in the iframe is
// same-origin with vlo and can reach any route without going through it.

export const ROOT_URL_REWRITE_PREFIX = "/comfyui-frame";
export const ROOT_URL_REWRITE_DISABLE_KEY = "vlo.comfyui.rootUrlRewrite";

const INSTALLED_KEY = Symbol.for("vlo.bridge.rootUrlRewrite.v1");
const PARSE_BASE = "http://root-url-rewrite.invalid";

function isUnderPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Return the prefixed root-relative URL for a root-absolute string outside
 * the prefix, or null when the request should go out unchanged.
 */
export function rewriteRootUrl(input, prefix = ROOT_URL_REWRITE_PREFIX) {
  // "//host" and "/\host" are protocol-relative, not root-relative.
  if (typeof input !== "string" || !/^\/(?![/\\])/.test(input)) return null;

  // Normalise dot segments first so "/comfyui-frame/../app" is judged by the
  // path the browser will actually request.
  let url;
  try {
    url = new URL(input, PARSE_BASE);
  } catch {
    return null;
  }
  if (url.origin !== PARSE_BASE || isUnderPrefix(url.pathname, prefix)) {
    return null;
  }
  return `${prefix}${url.pathname}${url.search}${url.hash}`;
}

function isDisabled(windowObject) {
  try {
    return (
      windowObject.localStorage?.getItem(ROOT_URL_REWRITE_DISABLE_KEY) === "off"
    );
  } catch {
    return false;
  }
}

/**
 * Wrap fetch, XMLHttpRequest, EventSource, WebSocket and sendBeacon on
 * `windowObject`. Installs once per window, only on pages served under the
 * prefix, and can be switched off by setting localStorage
 * `vlo.comfyui.rootUrlRewrite` to "off".
 */
export function installRootUrlRewrite({
  windowObject = globalThis,
  prefix = ROOT_URL_REWRITE_PREFIX,
  logger = globalThis.console,
} = {}) {
  const location = windowObject.location;
  if (
    !location ||
    windowObject[INSTALLED_KEY] ||
    !isUnderPrefix(location.pathname, prefix) ||
    isDisabled(windowObject)
  ) {
    return null;
  }

  const loggedRoots = new Set();
  const rewrite = (input) => {
    const rewritten = rewriteRootUrl(input, prefix);
    if (rewritten !== null) {
      const [, root = ""] = rewritten.slice(prefix.length).split(/[/?#]/);
      if (!loggedRoots.has(root)) {
        loggedRoots.add(root);
        logger?.info?.(
          `[vlo-bridge] Routing root-absolute /${root} requests through ${prefix} so they reach ComfyUI.`,
        );
      }
    }
    return rewritten;
  };
  const restores = [];

  const originalFetch = windowObject.fetch;
  if (typeof originalFetch === "function") {
    // Native fetch must be called on the window; a bare fetch() call from a
    // module gives this wrapper an undefined receiver.
    windowObject.fetch = function vloFetch(input) {
      const args = Array.from(arguments);
      const rewritten = rewrite(input);
      if (rewritten !== null) args[0] = rewritten;
      return originalFetch.apply(windowObject, args);
    };
    restores.push(() => {
      windowObject.fetch = originalFetch;
    });
  }

  const xhrPrototype = windowObject.XMLHttpRequest?.prototype;
  const originalOpen = xhrPrototype?.open;
  if (typeof originalOpen === "function") {
    xhrPrototype.open = function vloOpen(_method, url) {
      // Forward the caller's exact arity: open(method, url) is async, but an
      // explicit undefined third argument would make the request synchronous.
      const args = Array.from(arguments);
      const rewritten = rewrite(url);
      if (rewritten !== null) args[1] = rewritten;
      return originalOpen.apply(this, args);
    };
    restores.push(() => {
      xhrPrototype.open = originalOpen;
    });
  }

  for (const name of ["EventSource", "WebSocket"]) {
    const Original = windowObject[name];
    if (typeof Original !== "function") continue;
    // A subclass keeps instanceof, the static readyState constants and the
    // prototype, which a plain wrapper function would lose.
    const Wrapped = class extends Original {
      constructor(url, ...rest) {
        super(rewrite(url) ?? url, ...rest);
      }
    };
    Object.defineProperty(Wrapped, "name", { value: name });
    windowObject[name] = Wrapped;
    restores.push(() => {
      windowObject[name] = Original;
    });
  }

  const navigatorObject = windowObject.navigator;
  const originalSendBeacon = navigatorObject?.sendBeacon;
  if (typeof originalSendBeacon === "function") {
    navigatorObject.sendBeacon = function vloSendBeacon(url) {
      const args = Array.from(arguments);
      const rewritten = rewrite(url);
      if (rewritten !== null) args[0] = rewritten;
      return originalSendBeacon.apply(navigatorObject, args);
    };
    restores.push(() => {
      navigatorObject.sendBeacon = originalSendBeacon;
    });
  }

  windowObject[INSTALLED_KEY] = true;
  return {
    uninstall() {
      for (const restore of restores.reverse()) restore();
      delete windowObject[INSTALLED_KEY];
    },
  };
}
