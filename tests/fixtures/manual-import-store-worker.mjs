import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Store } from "../../src/runtime.mjs";
const [root, projectId, mode, name] = process.argv.slice(2);
const store = new Store(root);
const sessionId = `process:${process.pid}`;
const input = {
  format: "auto",
  document: {
    requests: [{ name, method: "GET", url: "https://example.invalid/import" }],
  },
  selection: { mode: "all" },
};
try {
  const preview = await store.previewManualImport(projectId, input, {
    sessionId,
  });
  if (!preview.token || preview.blockers.length) throw Error("preview blocked");
  process.send({ type: "ready", configRevision: preview.configRevision });
  await new Promise((resolve) => process.once("message", resolve));
  if (mode === "crash") {
    const rename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
      const result = await rename(from, to);
      if (String(to).endsWith(".transaction.json")) process.exit(23);
      return result;
    };
    syncBuiltinESMExports();
  }
  const receipt = await store.applyManualImport(
    projectId,
    { token: preview.token, input },
    { sessionId },
  );
  process.send({ type: "result", ok: true, receipt });
} catch (error) {
  process.send({ type: "result", ok: false, code: error.code || "ERROR" });
}
process.disconnect();
