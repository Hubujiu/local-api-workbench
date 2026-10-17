import { prepareConnection } from "./connection.mjs";
import { digestAuthorization } from "./digest.mjs";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { performance } from "node:perf_hooks";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { id, normalizeRequest } from "./core.mjs";
export class Store {
  constructor(root) {
    this.root = root;
    this.pending = Promise.resolve();
    this.locations = {};
  }
  async init() {
    await mkdir(this.root, { recursive: true });
    try {
      this.locations = JSON.parse(
        await readFile(path.join(this.root, ".locations.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  file(key) {
    if (!/^[a-zA-Z0-9-]+$/.test(key)) throw Error("无效项目 ID");
    return path.join(this.locations[key] || this.root, key + ".json");
  }
  async list() {
    await this.init();
    const names = (await readdir(this.root)).filter(
      (name) => name.endsWith(".json") && !name.startsWith("."),
    );
    const keys = new Set([
      ...names.map((name) => name.slice(0, -5)),
      ...Object.keys(this.locations),
    ]);
    const out = [];
    for (const key of keys) {
      try {
        const p = await this.get(key);
        out.push({
          id: p.id,
          name: p.name,
          updatedAt: p.updatedAt,
          archived: !!p.archived,
        });
      } catch (error) {
        out.push({
          id: key,
          name: key + "（文件无法读取）",
          error: error.message,
        });
      }
    }
    return out;
  }
  async get(key) {
    await this.init();
    return JSON.parse(await readFile(this.file(key), "utf8"));
  }
  async create(name, directory) {
    const p = {
      version: 1,
      id: id(),
      name: String(name || "新项目").slice(0, 100),
      requests: [],
      environments: [
        {
          id: id(),
          name: "默认环境",
          variables: { baseUrl: "http://127.0.0.1:4318" },
        },
      ],
      plans: [],
      runs: [],
      history: [],
      dictionary: [],
      documents: [],
      settings: {},
    };
    if (directory) {
      if (!path.isAbsolute(directory)) throw Error("存储位置必须是绝对路径");
      await this.init();
      await mkdir(directory, { recursive: true });
      const registryLock = path.join(this.root, ".registry.lock");
      let locked = false;
      for (let retry = 0; retry < 100; retry++) {
        try {
          await mkdir(registryLock);
          locked = true;
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      if (!locked) throw Error("项目注册表正忙，请稍后重试");
      try {
        await this.init();
        this.locations[p.id] = path.resolve(directory);
        const temporary = path.join(this.root, ".locations." + id() + ".tmp");
        await writeFile(temporary, JSON.stringify(this.locations, null, 2), {
          mode: 0o600,
        });
        await rename(temporary, path.join(this.root, ".locations.json"));
      } finally {
        await rm(registryLock, { recursive: true, force: true });
      }
    }
    await this.save(p);
    return p;
  }
  async save(p) {
    const task = this.pending
      .catch(() => {})
      .then(async () => {
        await this.init();
        const file = this.file(p.id),
          lock = file + ".lock";
        let locked = false;
        for (let n = 0; n < 100; n++) {
          try {
            await mkdir(lock);
            locked = true;
            break;
          } catch (e) {
            if (e.code !== "EEXIST") throw e;
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        if (!locked) throw Error("项目正在由其他进程写入，请稍后重试");
        try {
          let previous;
          try {
            previous = await this.get(p.id);
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          if (previous && (p.revision || 0) !== (previous.revision || 0))
            throw Error("项目已被其他窗口或 MCP 修改，请重新加载后再保存");
          const next = structuredClone(p);
          next.revision = (previous?.revision || 0) + 1;
          next.updatedAt = new Date().toISOString();
          const tmp = file + "." + id() + ".tmp";
          await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", {
            mode: 0o600,
          });
          await rename(tmp, file);
          Object.assign(p, next);
          return p;
        } finally {
          await rm(lock, { recursive: true, force: true });
        }
      });
    this.pending = task;
    return task;
  }
  async append(key, field, value, limit = 50) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const p = await this.get(key);
      p[field] = [value, ...(p[field] || [])].slice(0, limit);
      try {
        return await this.save(p);
      } catch (e) {
        if (!e.message.includes("其他窗口") || attempt === 4) throw e;
      }
    }
  }
}
export async function executeRequest(input, signal) {
  const r = normalizeRequest(input);
  let raw = r.url;
  for (const p of r.path.filter((p) => p.enabled !== false && p.key))
    raw = raw.replaceAll("{" + p.key + "}", encodeURIComponent(p.value));
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol))
    throw Error("仅支持 HTTP/HTTPS");
  if (u.username || u.password) throw Error("请在认证面板配置凭据");
  for (const p of r.query.filter((p) => p.enabled !== false && p.key))
    u.searchParams.append(p.key, String(p.value ?? ""));
  const headers = {};
  for (const h of r.headers.filter((h) => h.enabled !== false && h.key)) {
    if (/[\r\n]/.test(h.key + String(h.value))) throw Error("非法请求头");
    headers[h.key] = String(h.value ?? "");
  }
  if (r.auth.type === "bearer" || r.auth.type === "oauth2") {
    if (!r.auth.token) throw Error("请填写或获取 Bearer Token");
    headers.Authorization = "Bearer " + r.auth.token;
  }
  if (r.auth.type === "basic")
    headers.Authorization =
      "Basic " +
      Buffer.from(`${r.auth.username || ""}:${r.auth.password || ""}`).toString(
        "base64",
      );
  if (r.auth.type === "apiKey") {
    if (r.auth.in === "query") u.searchParams.set(r.auth.key, r.auth.value);
    else headers[r.auth.key] = r.auth.value;
  }
  if (r.cookies.length)
    headers.Cookie = r.cookies
      .filter((c) => c.enabled !== false)
      .map((c) => `${c.key}=${c.value}`)
      .join("; ");
  let body;
  if (r.bodyType === "json") {
    JSON.parse(r.body || "{}");
    body = r.body || "{}";
    headers["Content-Type"] ??= "application/json";
  } else if (r.bodyType === "urlencoded") {
    body = new URLSearchParams(
      r.form.filter((f) => f.enabled !== false).map((f) => [f.key, f.value]),
    ).toString();
    headers["Content-Type"] ??= "application/x-www-form-urlencoded";
  } else if (r.bodyType === "form-data") {
    const boundary = "----localapi" + id(),
      chunks = [];
    for (const field of r.form.filter((f) => f.enabled !== false)) {
      if (field.requiresFile)
        throw Error("请重新选择导入的文件: " + field.filename);
      const name = String(field.key).replace(/["\r\n]/g, "");
      const filename =
        field.type === "file"
          ? String(field.filename || "file").replace(/["\r\n]/g, "")
          : null;
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ""}\r\n${filename ? "Content-Type: application/octet-stream\r\n" : ""}\r\n`,
        ),
      );
      chunks.push(
        filename
          ? Buffer.from(field.value || "", "base64")
          : Buffer.from(String(field.value ?? "")),
      );
      chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    body = Buffer.concat(chunks);
    headers["Content-Type"] = "multipart/form-data; boundary=" + boundary;
  } else if (r.bodyType === "binary") {
    body = Buffer.from(r.body, "base64");
  } else if (r.bodyType !== "none") body = r.body;
  if (body && Buffer.byteLength(body) > 8 * 1024 * 1024)
    throw Error("请求体超过 8 MiB");
  if (body) headers["Content-Length"] = Buffer.byteLength(body);
  const start = performance.now();
  const connection = await prepareConnection(u, r, headers, signal);
  const remainingTimeout = r.timeout - (performance.now() - start);
  if (remainingTimeout <= 0) {
    connection.cleanup();
    throw Error("请求超时");
  }
  const response = await new Promise((resolve, reject) => {
    const req = connection.client.request(
      connection.url,
      { method: r.method, headers, signal, ...connection.options },
      (res) => {
        const chunks = [];
        let size = 0;
        const encoding = res.headers["content-encoding"];
        const decoder =
          encoding === "gzip"
            ? createGunzip()
            : encoding === "deflate"
              ? createInflate()
              : encoding === "br"
                ? createBrotliDecompress()
                : null;
        const stream = decoder ? res.pipe(decoder) : res;
        if (decoder) res.on("error", (e) => decoder.destroy(e));
        stream.on("data", (c) => {
          size += c.length;
          if (size > 8 * 1024 * 1024) {
            stream.destroy(Error("响应超过 8 MiB"));
            res.destroy();
            req.destroy();
          } else chunks.push(c);
        });
        stream.on("error", (error) => {
          clearTimeout(totalTimer);
          reject(error);
        });
        stream.on("end", () => {
          clearTimeout(totalTimer);
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            size,
            duration: Math.round((performance.now() - start) * 100) / 100,
            request: {
              method: r.method,
              url: u.href,
              headers,
              body: body?.toString() || "",
            },
          });
        });
      },
    );
    const totalTimer = setTimeout(
      () => req.destroy(Error("请求超时（总时限已到）")),
      remainingTimeout,
    );
    req.setTimeout(remainingTimeout, () => req.destroy(Error("请求超时")));
    req.on("error", (error) => {
      clearTimeout(totalTimer);
      reject(error);
    });
    if (body) req.write(body);
    req.end();
  }).finally(() => connection.cleanup());
  if (
    r.auth.type === "digest" &&
    response.status === 401 &&
    /^Digest\s/i.test(response.headers["www-authenticate"] || "")
  ) {
    const remaining = r.timeout - (performance.now() - start);
    if (remaining <= 0) throw Error("Digest 认证超时");
    const authorization = digestAuthorization(
      response.headers["www-authenticate"],
      r.auth,
      r.method,
      u.pathname + u.search,
      body || "",
    );
    const authenticated = await executeRequest(
      {
        ...r,
        auth: { type: "none" },
        timeout: remaining,
        headers: [
          ...r.headers.filter(
            (header) => header.key.toLowerCase() !== "authorization",
          ),
          { key: "Authorization", value: authorization, enabled: true },
        ],
      },
      signal,
    );
    authenticated.authHandshake = {
      status: response.status,
      duration: response.duration,
    };
    return authenticated;
  }
  return response;
}
