import sdk from "./vendor/url-sdk-host.js";
import { captureURLSnapshot } from "./script-url-state.mjs";
import { restoreQueryRuntime } from "./script-url-runtime.mjs";
// Explicit opt-in facade. Existing string-mode scripts are unchanged.
export function installURLFacade({ pm, apt, initial, dialect = "apipost8" }) {
  let current = restoreQueryRuntime(initial);
  const seen = new WeakMap([[current.url, current]]);
  const wrap = (url) => ({
    url,
    snapshot: () => {
      const state = captureURLSnapshot(url);
      return {
        state,
        origins: state.url.query.map(() => ({ encoding: "raw" })),
      };
    },
  });
  Object.defineProperty(pm.request, "url", {
    enumerable: true,
    configurable: false,
    get: () => current.url,
    set(value) {
      if (value === current.url) return;
      let next;
      if (typeof value === "string") next = wrap(new sdk.Url(value));
      else if (value instanceof sdk.Url) next = seen.get(value) || wrap(value);
      else throw Error("SDK URL赋值需要字符串或Url对象");
      next.snapshot(); // Validate before replacing the active object.
      current = next;
      seen.set(next.url, next);
    },
  });
  pm.request.addQueryParams = (value) => {
    current.url.addQueryParams(value);
  };
  pm.request.removeQueryParams = (value) => {
    current.url.removeQueryParams(value);
  };
  const set = (key, value) => {
    current.url.query.upsert({ key, value: String(value) });
  };
  pm.setRequestQuery = set;
  pm.removeRequestQuery = (key) => {
    current.url.query.remove(key);
  };
  apt.request = pm.request;
  apt.setRequestQuery =
    dialect === "apipost8" ? set : (key, value) => set(key, value ?? "");
  apt.removeRequestQuery = pm.removeRequestQuery;
  return () => current.snapshot();
}
