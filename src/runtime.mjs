import { readImportedNativeFlowSource } from "./imported-native-flow-source.mjs";
import {
  normalizeImportedNativeTaskSource,
  validateRequestTaskSource,
} from "./imported-native-task-source.mjs";
import { normalizeDirectoryArtifacts } from "./apipost-directory-artifacts.mjs";
import { normalizeNativeMock } from "./native-mock.mjs";
import { normalizeGrpcDefinitions } from "./grpc.mjs";
import { validateAPIResourceTrash } from "./api-resource-lifecycle.mjs";
import { validateProtocolRuns } from "./protocol-evidence.mjs";
import { normalizeSocketIODefinitions } from "./socketio.mjs";
import { validateCaseFolders } from "../public/case-folders.js";
import { requestCookieHeader } from "./request-cookies.mjs";
import {
  appendRequestQuery,
  setURLQuery,
  setAPIKeyQuery,
} from "./query-serialization.mjs";
import { requestHeaderMap } from "./request-headers.mjs";
import { asapAuthorization } from "./asap-auth.mjs";
import { jwtAuthorization } from "./jwt-auth.mjs";
import { validateModelFolders } from "../public/model-folders.js";
import { validateSharedScriptSettings } from "./shared-scripts.mjs";
import { validateSharedAuthSettings } from "./shared-auth.mjs";
import {
  validateGlobalParameters,
  validateFolderParameters,
} from "./global-parameters.mjs";
import { ntlmType1, parseNtlmChallenge, ntlmType3 } from "./ntlm.mjs";
import { edgegridAuthorization } from "./edgegrid-auth.mjs";
import { hawkAuthorization } from "./hawk-auth.mjs";
import { awsSignatureRequest, validateAWSQueryURL } from "./aws-signature.mjs";
import { validateAuth } from "../public/auth-model.js";
import { oauth1Request, oauth1ParameterPolicy } from "./oauth1.mjs";
import { validateAttributeValues } from "../public/attribute-model.js";
import { validateMockFieldSettings } from "./mock-fields.mjs";
import { normalizeParameterEntry } from "./parameter-dictionary.mjs";
import { normalizeProtocol } from "./protocol-definitions.mjs";
import { existsSync } from "node:fs";
import {
  readProject,
  writeProject,
  projectFingerprint,
} from "./project-files.mjs";
import { validateMockRules } from "./mock.mjs";
import { validateResources } from "./resources.mjs";
import { snapshotCase } from "./cases.mjs";
import { validateEnvironmentModel } from "./environments.mjs";
import { acquireFileLock } from "./file-lock.mjs";
import { prepareConnection } from "./connection.mjs";
import { digestAuthorization, digestChallengePolicy } from "./digest.mjs";
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
import { id, normalizeRequest, snapshotPlan } from "./core.mjs";
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
  base(key) {
    if (!/^[a-zA-Z0-9-]+$/.test(key)) throw Error("无效项目 ID");
    return this.locations[key] || this.root;
  }
  directory(key) {
    return path.join(this.base(key), key);
  }
  legacyFile(key) {
    return path.join(this.base(key), key + ".json");
  }
  lockFile(key) {
    return this.legacyFile(key) + ".lock";
  }
  file(key) {
    const metadata = path.join(this.directory(key), "project.json");
    return existsSync(metadata) ? metadata : this.legacyFile(key);
  }
  async list() {
    await this.init();
    const entries = await readdir(this.root, { withFileTypes: true });
    const keys = new Set([
      ...entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".json") &&
            !entry.name.startsWith("."),
        )
        .map((entry) => entry.name.slice(0, -5)),
      ...entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            /^[a-zA-Z0-9-]+$/.test(entry.name) &&
            (existsSync(path.join(this.root, entry.name, "project.json")) ||
              existsSync(
                path.join(this.root, entry.name, ".transaction.json"),
              )),
        )
        .map((entry) => entry.name),
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
  async readUnlocked(key) {
    const directory = this.directory(key);
    if (
      existsSync(path.join(directory, "project.json")) ||
      existsSync(path.join(directory, ".transaction.json"))
    )
      return readProject(directory, key);
    const project = JSON.parse(await readFile(this.legacyFile(key), "utf8"));
    project._diskFingerprint = projectFingerprint(project);
    return project;
  }
  async get(key) {
    await this.init();
    const release = await acquireFileLock(this.lockFile(key));
    try {
      return await this.readUnlocked(key);
    } finally {
      await release();
    }
  }
  async create(name, directory, { description } = {}) {
    const p = {
      version: 1,
      id: id(),
      name: String(name || "新项目").slice(0, 100),
      ...(description === undefined ? {} : { description }),
      requests: [],
      environments: [
        {
          id: id(),
          name: "默认环境",
          variables: { baseUrl: "http://127.0.0.1:4318" },
        },
      ],
      plans: [],
      cases: [],
      protocols: [],
      runs: [],
      protocolRuns: [],
      history: [],
      dictionary: [],
      parameterDictionary: [],
      documents: [],
      settings: {},
    };
    if (directory) {
      if (!path.isAbsolute(directory)) throw Error("存储位置必须是绝对路径");
      await this.init();
      await mkdir(directory, { recursive: true });
      const registryLock = path.join(this.root, ".registry.lock");
      const releaseRegistry = await acquireFileLock(registryLock);
      try {
        await this.init();
        this.locations[p.id] = path.resolve(directory);
        const temporary = path.join(this.root, ".locations." + id() + ".tmp");
        await writeFile(temporary, JSON.stringify(this.locations, null, 2), {
          mode: 0o600,
        });
        await rename(temporary, path.join(this.root, ".locations.json"));
      } finally {
        await releaseRegistry();
      }
    }
    await this.save(p);
    return p;
  }
  async save(p, { activity = false } = {}) {
    validateAPIResourceTrash(p);
    validateEnvironmentModel(p);
    validateModelFolders(p);
    validateCaseFolders(p);
    if (p.protocols !== undefined) {
      if (!Array.isArray(p.protocols) || p.protocols.length > 1000)
        throw Error("协议定义最多1000个");
      p.protocols = p.protocols.map(normalizeProtocol);
    }
    p.documents = (p.documents || []).map((document) => ({
      ...document,
      id: document.id || id(),
    }));
    if (!Array.isArray(p.plans) || p.plans.length > 1000)
      throw Error("计划最多1000个");
    p.plans = p.plans.map(snapshotPlan);
    for (const run of p.runs || [])
      if (run.snapshot) readImportedNativeFlowSource(run.snapshot);
    if (p.settings?.grpcDefinitions !== undefined)
      p.settings.grpcDefinitions = normalizeGrpcDefinitions(
        p.settings.grpcDefinitions,
      );
    if (p.settings?.socketioDefinitions !== undefined)
      p.settings.socketioDefinitions = normalizeSocketIODefinitions(
        p.settings.socketioDefinitions,
      );
    validateProtocolRuns(p.protocolRuns ?? []);
    if (p.settings?.apipostDirectoryArtifacts !== undefined)
      p.settings.apipostDirectoryArtifacts = normalizeDirectoryArtifacts(
        p.settings.apipostDirectoryArtifacts,
      );
    validateResources(p.settings || {});
    validateSharedAuthSettings(p.settings);
    validateSharedScriptSettings(p.settings);
    validateGlobalParameters(p.settings?.globalParameters);
    validateFolderParameters(p.settings?.folderParameters);
    for (const record of [...(p.requests || []), ...p.documents]) {
      validateAttributeValues(record.attributes, p.settings?.attributes || []);
      if (
        record.statusId !== undefined &&
        (typeof record.statusId !== "string" || record.statusId.length > 200)
      )
        throw Error("状态标识无效");
    }
    const fieldRules = validateMockFieldSettings(p.settings || {});
    if (p.settings?.mockFieldRules !== undefined)
      p.settings.mockFieldRules = fieldRules;
    if (p.parameterDictionary !== undefined) {
      if (
        !Array.isArray(p.parameterDictionary) ||
        p.parameterDictionary.length > 5000
      )
        throw Error("参数字典最多5000条");
      p.parameterDictionary = p.parameterDictionary.map(
        normalizeParameterEntry,
      );
    }
    for (const request of p.requests || []) {
      validateAuth(request.auth);
      validateRequestTaskSource(request);
      validateMockRules(request.mockRules || []);
      if (request.importedNativeTaskSource !== undefined)
        request.importedNativeTaskSource = normalizeImportedNativeTaskSource(
          request.importedNativeTaskSource,
        );
      if (request.nativeMock !== undefined) {
        if (request.mockRules?.length)
          throw Error("原版Mock与普通Mock规则不能混用");
        request.nativeMock = normalizeNativeMock(request.nativeMock);
      }
    }
    if (p.cases !== undefined) {
      if (!Array.isArray(p.cases) || p.cases.length > 1000)
        throw Error("用例最多1000个");
      p.cases = p.cases.map(snapshotCase);
      if (new Set(p.cases.map((item) => item.id)).size !== p.cases.length)
        throw Error("用例ID重复");
    }
    const task = this.pending
      .catch(() => {})
      .then(async () => {
        await this.init();
        const lock = this.lockFile(p.id);
        const release = await acquireFileLock(lock);
        try {
          let previous;
          try {
            previous = await this.readUnlocked(p.id);
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          if (
            previous &&
            p._diskFingerprint &&
            p._diskFingerprint !== previous._diskFingerprint
          )
            throw Error("项目文件已被其他窗口或 Git 修改，请重新加载后再保存");
          const previousConfiguration =
            previous?.configRevision ?? previous?.revision ?? 0;
          const expectedConfiguration = p.configRevision ?? p.revision ?? 0;
          if (
            previous &&
            (activity
              ? (p.revision || 0) !== (previous.revision || 0)
              : expectedConfiguration !== previousConfiguration)
          )
            throw Error("项目已被其他窗口或 MCP 修改，请重新加载后再保存");
          const next = structuredClone(p);
          next.revision = (previous?.revision || 0) + 1;
          next.configRevision = activity
            ? previousConfiguration
            : previousConfiguration + 1;
          if (!activity && previous) {
            next.history = previous.history;
            next.runs = previous.runs;
            next.protocolRuns = previous.protocolRuns || [];
          }
          next.updatedAt = new Date().toISOString();
          await writeProject(this.directory(p.id), next);
          Object.assign(p, await readProject(this.directory(p.id), p.id));
          return p;
        } finally {
          await release();
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
        return await this.save(p, { activity: true });
      } catch (e) {
        if (!e.message.includes("其他窗口") || attempt === 4) throw e;
      }
    }
  }
}
// Private retry state cannot be supplied through serialized request definitions.
const digestEntityReplay = Symbol("digest-entity-replay");
export async function executeRequest(input, signal, options = {}) {
  const { cookieSession } = options;
  const replay = options[digestEntityReplay];
  const r = normalizeRequest(input);
  // Validate before any connection/cookie operation and detach mutable caller
  // policy objects. Awaiting the challenge cannot change this invocation policy.
  const digestPolicy =
    r.auth.type === "digest" ? digestChallengePolicy(r.auth) : undefined;
  if (digestPolicy) r.auth.challengePolicy = digestPolicy;
  const oauthPolicy =
    r.auth.type === "oauth1" ? oauth1ParameterPolicy(r.auth) : undefined;
  if (oauthPolicy) r.auth.parameterPolicy = oauthPolicy;
  let raw = r.url;
  for (const p of r.path.filter((p) => p.enabled !== false && p.key))
    raw = raw.replaceAll("{" + p.key + "}", encodeURIComponent(p.value));
  if (r.auth.type === "aws" && r.auth.addAuthDataToQuery === true)
    validateAWSQueryURL(raw);
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol))
    throw Error("仅支持 HTTP/HTTPS");
  if (u.username || u.password) throw Error("请在认证面板配置凭据");
  appendRequestQuery(u, r.query, r.queryAddEqual);
  const headers = requestHeaderMap(r.headers, r.auth.type);
  if (r.auth.type === "bearer" || r.auth.type === "oauth2") {
    if (!r.auth.token) throw Error("请填写或获取 Bearer Token");
    headers.authorization = "Bearer " + r.auth.token;
  }
  if (r.auth.type === "basic")
    headers.authorization =
      "Basic " +
      Buffer.from(`${r.auth.username || ""}:${r.auth.password || ""}`).toString(
        "base64",
      );
  if (r.auth.type === "apiKey") {
    if (r.auth.in === "query") setAPIKeyQuery(u, r.auth);
    else headers[r.auth.key] = r.auth.value;
  }
  if (r.auth.type === "asap")
    headers.authorization = (await asapAuthorization(r.auth)).value;
  if (r.auth.type === "jwt") {
    const jwt = await jwtAuthorization(r.auth);
    if (jwt.in === "query") setURLQuery(u, jwt.key, jwt.value);
    else headers[jwt.key] = jwt.value;
  }
  const cookieHeader = requestCookieHeader(r.cookies, r.cookieEncoding);
  if (cookieHeader !== undefined) headers.cookie = cookieHeader;
  if (cookieSession) {
    const managed = await cookieSession.header(u.href);
    if (managed !== null) {
      if (managed) headers.cookie = managed;
      else delete headers.cookie;
    }
  }
  let body;
  if (replay) {
    body = replay.body;
    if (replay.contentType !== undefined)
      headers["content-type"] = replay.contentType;
  } else if (r.bodyType === "msgpack") {
    const { encode } = await import("@msgpack/msgpack");
    body = Buffer.from(encode(JSON.parse(r.body || "{}"), { maxDepth: 64 }));
    headers["content-type"] ??= "application/msgpack";
  } else if (r.bodyType === "json") {
    JSON.parse(r.body || "{}");
    body = r.body || "{}";
    headers["content-type"] ??= "application/json";
  } else if (r.bodyType === "urlencoded") {
    body = new URLSearchParams(
      r.form.filter((f) => f.enabled !== false).map((f) => [f.key, f.value]),
    ).toString();
    headers["content-type"] ??= "application/x-www-form-urlencoded";
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
    headers["content-type"] = "multipart/form-data; boundary=" + boundary;
  } else if (r.bodyType === "binary") {
    body = Buffer.from(r.body, "base64");
  } else if (r.bodyType !== "none") body = r.body;
  if (body && Buffer.byteLength(body) > 8 * 1024 * 1024)
    throw Error("请求体超过 8 MiB");
  if (body) headers["content-length"] = Buffer.byteLength(body);
  if (r.auth.type === "oauth1") {
    const signed = oauth1Request(u.href, r.method, headers, body, r.auth, {
      bodyType: r.bodyType,
    });
    u.href = signed.url;
    body = signed.body;
    delete headers.authorization;
    Object.assign(headers, signed.headers);
  }
  if (r.auth.type === "aws") {
    const signed = await awsSignatureRequest(
      u.href,
      r.method,
      headers,
      body,
      r.auth,
    );
    u.href = signed.url;
    // Query signing removes/hoists authentication headers. Object.assign alone
    // would leave old Authorization or session-token headers on the wire.
    if (r.auth.addAuthDataToQuery === true)
      for (const key of Object.keys(headers)) delete headers[key];
    Object.assign(headers, signed.headers);
  }
  if (r.auth.type === "hawk")
    headers.authorization = hawkAuthorization(
      u.href,
      r.method,
      headers,
      body,
      r.auth,
    ).header;
  if (r.auth.type === "edgegrid")
    headers.authorization = edgegridAuthorization(
      u.href,
      r.method,
      headers,
      body,
      r.auth,
    );
  if (r.auth.type === "ntlm") {
    headers.authorization = ntlmType1(r.auth);
    headers.connection = "keep-alive";
  }
  const start = performance.now();
  const deadline = replay?.deadline ?? start + r.timeout;
  const connectionBudget = deadline - performance.now();
  if (connectionBudget <= 0) throw Error("请求超时");
  const connection = await prepareConnection(
    u,
    { ...r, timeout: Math.min(r.timeout, connectionBudget) },
    headers,
    signal,
  );
  let authSocket;
  const requestOnce = async (headers, expectedSocket) => {
    const remainingTimeout = deadline - performance.now();
    if (remainingTimeout <= 0) {
      connection.cleanup();
      throw Error("请求超时");
    }
    return await new Promise((resolve, reject) => {
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
          stream.on("end", async () => {
            clearTimeout(totalTimer);
            const raw = Buffer.concat(chunks);
            let displayBody = raw.toString("utf8"),
              rawBodyBase64,
              codecError;
            if (/msgpack/i.test(res.headers["content-type"] || "")) {
              rawBodyBase64 = raw.toString("base64");
              try {
                const { decode } = await import("@msgpack/msgpack");
                displayBody = JSON.stringify(
                  decode(raw, {
                    useBigInt64: true,
                    maxStrLength: 8388608,
                    maxBinLength: 8388608,
                    maxArrayLength: 100000,
                    maxMapLength: 100000,
                    maxExtLength: 8388608,
                  }),
                  (_key, value) =>
                    typeof value === "bigint"
                      ? value.toString()
                      : value instanceof Uint8Array
                        ? {
                            type: "binary",
                            base64: Buffer.from(value).toString("base64"),
                          }
                        : value,
                  null,
                  2,
                );
              } catch (error) {
                codecError = error.message;
                displayBody = rawBodyBase64;
              }
            }
            resolve({
              status: res.statusCode,
              protocol: res.httpVersion || "1.1",
              statusText: res.statusMessage,
              headers: res.headers,
              body: displayBody,
              rawBodyBase64,
              codecError,
              size,
              duration: Math.round((performance.now() - start) * 100) / 100,
              request: {
                method: r.method,
                url: u.href,
                headers: { ...headers },
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
      const sendBody = () => {
        if (body) req.write(body);
        req.end();
      };
      if (r.auth.type === "ntlm")
        req.once("socket", (socket) => {
          if (expectedSocket && socket !== expectedSocket) {
            req.destroy(Error("NTLM连接已更换，拒绝重放凭据"));
            return;
          }
          authSocket = socket;
          sendBody();
        });
      else sendBody();
    });
  };
  const response = await (async () => {
    const first = await requestOnce(headers);
    if (r.auth.type !== "ntlm" || first.status !== 401) return first;
    const challenge = parseNtlmChallenge(first.headers["www-authenticate"]);
    if (
      !authSocket ||
      authSocket.destroyed ||
      String(first.headers.connection || "").toLowerCase() === "close"
    )
      throw Error("NTLM服务器关闭连接，拒绝重放凭据");
    const authenticatedHeaders = {
      ...headers,
      authorization: ntlmType3(challenge, r.auth),
    };
    if (cookieSession && !signal?.aborted) {
      await cookieSession.capture(u.href, first.headers["set-cookie"]);
      const managed = await cookieSession.header(u.href);
      if (managed !== null) {
        if (managed) authenticatedHeaders.cookie = managed;
        else delete authenticatedHeaders.cookie;
      }
    }
    const final = await requestOnce(authenticatedHeaders, authSocket);
    final.authHandshake = {
      status: first.status,
      duration: first.duration,
      roundTrips: 2,
      protocol: "NTLMv2",
    };
    return final;
  })().finally(() => connection.cleanup());
  if (cookieSession && !signal?.aborted) {
    try {
      await cookieSession.capture(u.href, response.headers["set-cookie"]);
    } catch (error) {
      response.cookieError = "Cookie保存失败：" + error.message;
    }
  }
  if (
    r.auth.type === "digest" &&
    response.status === 401 &&
    digestPolicy?.retry !== false
  ) {
    const authorization = digestAuthorization(
      response.headers["www-authenticate"],
      r.auth,
      r.method,
      u.pathname + u.search,
      body || "",
    );
    if (authorization === null) return response;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw Error("Digest 认证超时");
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
      {
        cookieSession,
        [digestEntityReplay]: {
          body,
          contentType: headers["content-type"],
          deadline,
        },
      },
    );
    authenticated.authHandshake = {
      status: response.status,
      duration: response.duration,
    };
    return authenticated;
  }
  return response;
}
