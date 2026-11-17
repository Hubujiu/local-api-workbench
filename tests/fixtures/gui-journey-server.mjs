// Separate process: restarting must discard every in-memory authorization.
import { createApp } from "../../src/server.mjs";
const app = await createApp({ root: process.argv[2], port: 0 });
process.send({
  ready: true,
  pid: process.pid,
  url: app.url,
  launchUrl: app.launchUrl,
});
process.once("message", async (message) => {
  if (message !== "close") throw Error("Unexpected fixture command");
  app.server.closeAllConnections();
  await app.close();
  process.disconnect();
});
