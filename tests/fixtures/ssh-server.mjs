import ssh2 from "ssh2";
const { Server, utils } = ssh2;
import { generateKeyPairSync, createHash, createPrivateKey } from "node:crypto";
import net from "node:net";
export async function startSSHFixture({
  targets = [],
  rejectForward = false,
} = {}) {
  const key = () =>
    generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    }).privateKey;
  const hostKey = key(),
    privateKey = key(),
    allowed = utils.parseKey(privateKey);
  const fingerprint =
    "SHA256:" +
    createHash("sha256")
      .update(utils.parseKey(hostKey).getPublicSSH())
      .digest("base64")
      .replace(/=$/, "");
  const clients = new Set(),
    sockets = new Set();
  const stats = { authenticated: 0, forwarded: [], closed: 0 };
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.once("close", () => {
      clients.delete(client);
      stats.closed++;
    });
    client.on("authentication", (ctx) => {
      if (ctx.username !== "fixture") return ctx.reject();
      if (
        ctx.method === "password" &&
        ctx.password === "fixture-only-password"
      ) {
        stats.authenticated++;
        return ctx.accept();
      }
      if (
        ctx.method === "publickey" &&
        ctx.key.algo === allowed.type &&
        ctx.key.data.equals(allowed.getPublicSSH()) &&
        (!ctx.signature ||
          allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)
      ) {
        if (ctx.signature) stats.authenticated++;
        return ctx.accept();
      }
      ctx.reject();
    });
    client.on("ready", () => {
      client.on("session", (_accept, reject) => reject());
      client.on("tcpip", (accept, reject, info) => {
        stats.forwarded.push({ host: info.destIP, port: info.destPort });
        if (
          rejectForward ||
          !targets.some(
            (t) => t.host === info.destIP && t.port === info.destPort,
          )
        )
          return reject();
        const socket = net.connect(info.destPort, "127.0.0.1");
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        let channel;
        socket.on("error", () => {
          if (channel) channel.destroy();
          else reject();
        });
        socket.once("connect", () => {
          channel = accept();
          channel.on("error", () => socket.destroy());
          channel.once("close", () => socket.destroy());
          socket.pipe(channel).pipe(socket);
        });
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const ssh = {
    host: "127.0.0.1",
    port: server.address().port,
    username: "fixture",
    password: "fixture-only-password",
    hostKeySHA256: fingerprint,
  };
  return {
    ssh,
    privateKey,
    encryptedPrivateKey: createPrivateKey(privateKey).export({
      type: "pkcs1",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "fixture-key-passphrase",
    }),
    stats,
    async close() {
      for (const c of clients) c.end();
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}
