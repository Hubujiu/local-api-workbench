import { Store } from "../../src/runtime.mjs";

// Test-only scheduling instrumentation. The production entrypoint, conversion,
// Store reads, lock acquisition, journal writes and ENOENT remain unmodified.
// HTTP installs this on its own Store; stdio preloads it before src/mcp.mjs.
export function gateProjectSave(target, projectId, pause) {
  const own = Object.getOwnPropertyDescriptor(target, "save"),
    original = target.save;
  let selected = false;
  target.save = async function (project, ...options) {
    if (project.id === projectId && !selected) {
      selected = true;
      await pause({
        id: project.id,
        name: project.name,
        revision: project.revision,
        configRevision: project.configRevision,
        requests: project.requests.map(({ id, name, url }) => ({
          id,
          name,
          url,
        })),
        historyIds: project.history.map(({ id }) => id),
        documents: project.documents,
        marker: project.settings.fixtureMarker,
      });
    }
    return Reflect.apply(original, this, [project, ...options]);
  };
  return () => {
    if (own) Object.defineProperty(target, "save", own);
    else delete target.save;
  };
}

if (process.env.LOCAL_API_TEST_SAVE_GATE) {
  const url = new URL(process.env.LOCAL_API_TEST_SAVE_GATE),
    projectId = process.env.LOCAL_API_TEST_SAVE_PROJECT;
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/save-gate\/[a-f0-9-]{36}$/.test(url.pathname) ||
    !projectId
  )
    throw Error("Invalid test save-gate configuration");
  gateProjectSave(Store.prototype, projectId, async (proof) => {
    const body = JSON.stringify(proof);
    if (Buffer.byteLength(body) > 65536)
      throw Error("Test save-gate proof is too large");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (response.status !== 200 || (await response.text()) !== "resume")
      throw Error("Test save-gate handshake failed");
  });
}
