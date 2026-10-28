import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fork } from "node:child_process";
import tls from "node:tls";

// No socket or fixture-private-key read outside ordinary CI. This tests only
// Node's public trust/identity behavior, not Oracle or server-side cleanup.
test(
  "CI only: child custom-CA default context verifies TLS trust and hostname",
  {
    skip: process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true",
    timeout: 15000,
  },
  async () => {
    assert.equal(typeof tls.setDefaultCACertificates, "function");
    const before = tls.getCACertificates("default");
    const cert = await readFile(
      new URL("./fixtures/localhost.crt", import.meta.url),
      "utf8",
    );
    const key = await readFile(
      new URL("./fixtures/localhost.key", import.meta.url),
      "utf8",
    );
    const sockets = new Set();
    const server = tls.createServer({ cert, key });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("tlsClientError", () => {});
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const input = {
        host: "localhost",
        port: server.address().port,
        service: "TLS_FIXTURE",
        user: "reader",
        password: "fixture-unused",
        ssl: true,
        sql: "SELECT 1 FROM DUAL",
      };
      const run = (patch) =>
        new Promise((resolve, reject) => {
          const child = fork(
            new URL("./fixtures/oracle-read-tls-client.mjs", import.meta.url),
            [],
            {
              execPath: process.execPath,
              execArgv: [],
              env: { NODE_V8_COVERAGE: "" },
              stdio: ["ignore", "ignore", "ignore", "ipc"],
              serialization: "advanced",
            },
          );
          let result, failure;
          const deadline = setTimeout(() => {
            failure = Error("TLS proof child deadline");
            child.kill("SIGKILL");
          }, 4000);
          child.on("error", () => {
            failure = Error("TLS proof child failed");
            child.kill("SIGKILL");
          });
          child.on("message", (value) => {
            result = value;
          });
          child.once("close", (code, signal) => {
            clearTimeout(deadline);
            if (failure || code !== 0 || signal || !result)
              reject(failure || Error("TLS proof child did not close cleanly"));
            else resolve(result);
          });
          child.send({ ...input, ...patch }, (error) => {
            if (error) {
              failure = Error("TLS proof IPC failed");
              child.kill("SIGKILL");
            }
          });
        });
      assert.deepEqual(await run({ caCertificatePem: cert }), {
        authorized: true,
      });
      assert.deepEqual(
        await run({ caCertificatePem: cert, host: "wrong.example.test" }),
        {
          authorized: false,
          code: "ERR_TLS_CERT_ALTNAME_INVALID",
        },
      );
      assert.deepEqual(await run({}), {
        authorized: false,
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      });
      assert.deepEqual(tls.getCACertificates("default"), before);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
