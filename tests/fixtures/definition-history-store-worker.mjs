import { Store } from "../../src/runtime.mjs";
const [root, id, name] = process.argv.slice(2);
const store = new Store(root),
  project = await store.get(id);
const timeout = setTimeout(() => process.exit(2), 12000);
process.send({ type: "ready" });
process.once("message", async (message) => {
  try {
    if (message?.type !== "save") throw Error("unexpected fixture instruction");
    project.requests[0].name = name;
    await store.save(project);
    process.send({ type: "saved" });
  } catch (error) {
    if (!/其他窗口|已被其他/.test(error.message)) throw error;
    process.send({ type: "conflict" });
  } finally {
    clearTimeout(timeout);
    process.disconnect();
  }
});
