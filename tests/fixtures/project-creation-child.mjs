import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Store } from "../../src/runtime.mjs";
import { writeProject } from "../../src/project-files.mjs";
const [root, custom, phase] = process.argv.slice(2),
  store = new Store(root);
store.readUnlocked = async (id, base) => {
  const target = path.join(base, id);
  await writeFile(path.join(target, "keep.txt"), "user data");
  if (phase !== "before-journal") {
    if (phase === "journal")
      await writeFile(path.join(target, "apis"), "blocked");
    try {
      await writeProject(target, {
        id,
        name: "interrupted",
        version: 1,
        revision: 1,
        configRevision: 1,
        requests: [],
        environments: [],
        plans: [],
        cases: [],
        protocols: [],
        settings: {},
      });
    } catch (error) {
      if (phase !== "journal" || error.code !== "PROJECT_COMMIT_UNCERTAIN")
        throw error;
    }
  }
  process.send({ id, phase });
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
};
await store.create("interrupted", custom);
