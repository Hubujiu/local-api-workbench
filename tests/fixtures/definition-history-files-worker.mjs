import path from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { acquireFileLock } from "../../src/file-lock.mjs";
import { readProject, writeProject } from "../../src/project-files.mjs";
import { reconcileRequestDefinitionHistory } from "../../src/request-definition-history.mjs";
const [root, projectId, mode, name] = process.argv.slice(2);
const directory = path.join(root, projectId);
const timeout = setTimeout(() => process.exit(2), 12000);
process.once("message", async (message) => {
  if (message?.type !== "go") throw Error("unexpected fixture instruction");
  const release = await acquireFileLock(path.join(root, projectId + ".lock"));
  try {
    const previous = await readProject(directory, projectId),
      next = structuredClone(previous);
    next.requests[0].name = name;
    next.revision = previous.revision + 1;
    next.requestDefinitionHistory = reconcileRequestDefinitionHistory(
      previous,
      next,
    );
    if (mode === "crash") {
      await rm(path.join(directory, "apis"), { recursive: true });
      await writeFile(
        path.join(directory, "apis"),
        "fail after journal publication",
      );
      try {
        await writeProject(directory, next);
        throw Error("fault did not trigger");
      } catch (error) {
        if (error.code !== "PROJECT_COMMIT_UNCERTAIN") throw error;
        process.send({ type: "published", revision: next.revision }, () =>
          process.exit(23),
        );
        return;
      }
    }
    await writeProject(directory, next);
    process.send({ type: "saved", revision: next.revision });
  } finally {
    if (mode !== "crash") {
      await release();
      clearTimeout(timeout);
      process.disconnect();
    }
  }
});
process.send({ type: "ready" });
