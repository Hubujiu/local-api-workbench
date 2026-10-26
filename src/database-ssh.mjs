import ssh2 from "ssh2";
const { Client } = ssh2;
import { timingSafeEqual } from "node:crypto";
import { isIP, connect } from "node:net";
import {
  checkDatabaseSignal,
  databaseCancelled,
} from "./database-read-cancellation.mjs";
let active = 0;
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
const host = (value) =>
  typeof value === "string" &&
  value.length <= 253 &&
  value.length > 0 &&
  !/[\s\x00-\x1f/\\@]/.test(value);
export function databaseSSHConfig(input) {
  if (!object(input)) throw Error("SSH 配置无效");
  const allowed = new Set([
    "host",
    "port",
    "username",
    "password",
    "privateKey",
    "passphrase",
    "hostKeySHA256",
  ]);
  if (Object.keys(input).some((k) => !allowed.has(k)))
    throw Error("SSH 包含未支持的配置项");
  if (!host(input.host)) throw Error("SSH 主机无效");
  const port = input.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("SSH 端口无效");
  if (
    typeof input.username !== "string" ||
    !input.username.trim() ||
    input.username.length > 256 ||
    /[\x00-\x1f]/.test(input.username)
  )
    throw Error("SSH 用户名无效");
  const hasPassword = Object.hasOwn(input, "password"),
    hasKey = Object.hasOwn(input, "privateKey");
  if (hasPassword === hasKey) throw Error("SSH 必须且只能提供密码或私钥之一");
  for (const key of ["password", "privateKey", "passphrase"])
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" || input[key].length > 65536)
    )
      throw Error("SSH 认证字段无效");
  if (hasPassword && typeof input.password !== "string")
    throw Error("SSH 密码必须是字符串");
  if (hasKey && typeof input.privateKey !== "string")
    throw Error("SSH 私钥必须是字符串");
  if (hasKey && !input.privateKey.trim()) throw Error("SSH 私钥为空");
  if (input.passphrase !== undefined && !hasKey)
    throw Error("SSH 私钥口令不能与密码认证混用");
  if (
    typeof input.hostKeySHA256 !== "string" ||
    !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(input.hostKeySHA256)
  )
    throw Error("SSH 必须提供已核对的 SHA256 主机指纹");
  const pin = input.hostKeySHA256.slice(7).replace(/=$/, "");
  if (Buffer.from(pin, "base64").toString("base64").replace(/=$/, "") !== pin)
    throw Error("SSH 主机指纹编码无效");
  return {
    host: input.host,
    port,
    username: input.username,
    hostKeySHA256: "SHA256:" + pin,
    ...(hasPassword
      ? { password: input.password }
      : {
          privateKey: input.privateKey,
          ...(input.passphrase !== undefined
            ? { passphrase: input.passphrase }
            : {}),
        }),
  };
}
export async function openDatabaseSSH(input, { signal } = {}) {
  checkDatabaseSignal(signal);
  if (input.ssh === undefined) return null;
  if (!["postgres", "mysql"].includes(input.type))
    throw Error("SSH 通道目前仅支持 PostgreSQL/MySQL，不会退回直连");
  const config = databaseSSHConfig(input.ssh);
  const targetHost = input.host || "127.0.0.1",
    targetPort =
      input.port === undefined
        ? input.type === "postgres"
          ? 5432
          : 3306
        : Number(input.port);
  if (
    !host(targetHost) ||
    !Number.isInteger(targetPort) ||
    targetPort < 1 ||
    targetPort > 65535
  )
    throw Error("SSH 数据库目标无效");
  if (input.ssl && isIP(targetHost))
    throw Error(
      "SSH 上的数据库 TLS 当前要求可校验证书的 DNS 主机名，不能使用 IP 代替",
    );
  if (active >= 5) throw Error("SSH 数据库并发最多5个");
  active++;
  const client = new Client();
  // Public ssh2 sock option gives this invocation an actual close boundary.
  const socket = connect({ host: config.host, port: config.port });
  socket.on("error", () => {});
  const transportClosed = new Promise((resolve) =>
    socket.once("close", () => {
      active--;
      resolve();
    }),
  );
  let stream,
    closed = false,
    rejectOpen,
    matched = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    stream?.destroy();
    client.destroy();
    socket.destroy();
  };
  const fail = (error) => {
    if (closed) return;
    rejectOpen?.(error);
    stream?.destroy(error);
    close();
  };
  const cancel = () => fail(databaseCancelled());
  const timer = setTimeout(
    () => fail(Error("SSH 数据库通道超过8秒，已关闭；不会重放请求")),
    8000,
  );
  client.on("error", (error) =>
    fail(
      Error(
        matched ? "SSH 通道失败: " + error.message : "SSH 主机校验或连接失败",
      ),
    ),
  );
  client.on("close", () => fail(Error("SSH 数据库通道已断开")));
  try {
    return await new Promise((resolve, reject) => {
      rejectOpen = reject;
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) {
        cancel();
        return;
      }
      client.once("ready", () => {
        if (closed || signal?.aborted) {
          cancel();
          return;
        }
        client.forwardOut(
          "127.0.0.1",
          0,
          targetHost,
          targetPort,
          (error, channel) => {
            if (closed || signal?.aborted) {
              channel?.destroy();
              return;
            }
            if (error) {
              fail(Error("SSH 目标转发失败: " + error.message));
              return;
            }
            stream = channel;
            stream.on("error", () => {}); // Driver listeners report active operation errors.
            // pg expects a socket-like connect notification. No DNS lookup or
            // second connection occurs: this is the already pinned SSH channel.
            let connected = false;
            stream.connect = () => {
              if (!connected) {
                connected = true;
                queueMicrotask(() => {
                  if (!closed) stream.emit("connect");
                });
              }
              return stream;
            };
            stream.setNoDelay = () => stream;
            stream.setKeepAlive = () => stream;
            stream.ref = () => stream;
            stream.unref = () => stream;
            resolve({ stream, close, closed: transportClosed });
          },
        );
      });
      const { hostKeySHA256, ...credentials } = config;
      client.connect({
        ...credentials,
        sock: socket,
        readyTimeout: 3000,
        keepaliveInterval: 1000,
        keepaliveCountMax: 2,
        hostHash: "sha256",
        hostVerifier: (digest) => {
          const received = Buffer.from(digest, "hex"),
            expected = Buffer.from(hostKeySHA256.slice(7), "base64");
          matched =
            received.length === expected.length &&
            timingSafeEqual(received, expected);
          return matched;
        },
      });
    });
  } catch (error) {
    close();
    await transportClosed;
    throw error;
  }
}
