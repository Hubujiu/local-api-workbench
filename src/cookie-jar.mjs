import { selectedEnvironment } from "./environments.mjs";
import { Cookie, CookieJar } from "tough-cookie";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { acquireFileLock } from "./file-lock.mjs";
import { throwIfInactive } from "./request-control.mjs";
const maximum = 500;
function httpURL(value) {
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw Error("Cookie仅支持无内联凭据的HTTP/HTTPS URL");
  return u.href;
}
function freshJar() {
  return new CookieJar(undefined, {
    prefixSecurity: "strict",
    allowSecureOnLocal: false,
    rejectPublicSuffixes: true,
  });
}
function freezeMaxAge(cookie, base = new Date()) {
  if (cookie && typeof cookie.maxAge === "number") {
    const millis =
      cookie.maxAge <= 0
        ? 0
        : Math.min(8640000000000000, base.getTime() + cookie.maxAge * 1000);
    cookie.expires = new Date(millis);
    cookie.maxAge = null;
  }
  return cookie;
}
function storeCookie(jar, line, url) {
  if (/[\x00-\x1f\x7f]/.test(line)) throw Error("Cookie不能包含控制字符");
  return freezeMaxAge(jar.setCookieSync(line, url));
}
function restore(cookies) {
  const jar = freshJar();
  if (!Array.isArray(cookies) || cookies.length > maximum)
    throw Error("Cookie存储格式无效或超过500项");
  for (const row of cookies) {
    const cookie = Cookie.fromJSON(row);
    if (
      !cookie ||
      !cookie.domain ||
      typeof cookie.path !== "string" ||
      !cookie.path.startsWith("/")
    )
      throw Error("Cookie存储条目无效");
    freezeMaxAge(
      cookie,
      cookie.lastAccessed instanceof Date ? cookie.lastAccessed : new Date(),
    );
    if (cookie.expiryTime() <= Date.now()) continue;
    const creation = cookie.creation,
      lastAccessed = cookie.lastAccessed;
    const hostOnly = cookie.hostOnly !== false,
      domain = cookie.domain;
    if (hostOnly) cookie.domain = undefined;
    const accepted = jar.setCookieSync(
      cookie,
      httpURL(
        "https://" + (domain.includes(":") ? "[" + domain + "]" : domain) + "/",
      ),
    );
    if (accepted) {
      accepted.hostOnly = hostOnly;
      accepted.creation = creation;
      accepted.lastAccessed = lastAccessed;
    }
  }
  return jar;
}
function entries(jar) {
  return jar
    .serializeSync()
    .cookies.filter((row) => Cookie.fromJSON(row).expiryTime() > Date.now());
}
/** Local-only cookie data, intentionally outside shareable project files/backups. */
export class ProjectCookieJar {
  constructor(root, projectId, environmentId = "") {
    if (
      typeof projectId !== "string" ||
      !/^[a-zA-Z0-9-]+$/.test(projectId) ||
      typeof environmentId !== "string" ||
      environmentId.length > 200
    )
      throw Error("Cookie项目/环境标识无效");
    this.directory = path.join(root, ".cookie-jars");
    this.file = path.join(
      this.directory,
      createHash("sha256")
        .update(projectId + "\0" + environmentId)
        .digest("hex") + ".json",
    );
  }
  async transact(
    fn,
    { write = false, expectedRevision, signal, deadline } = {},
  ) {
    const controls = { signal, deadline };
    throwIfInactive(controls);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    throwIfInactive(controls);
    const release = await acquireFileLock(this.file + ".lock", controls);
    let temporary;
    try {
      throwIfInactive(controls);
      let state = { version: 1, revision: 0, enabled: false, cookies: [] };
      try {
        const bytes = await readFile(this.file);
        if (bytes.length > 2 * 1024 * 1024) throw Error("Cookie存储超过2MiB");
        state = JSON.parse(bytes.toString());
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      throwIfInactive(controls);
      if (
        state.version !== 1 ||
        !Number.isSafeInteger(state.revision) ||
        state.revision < 0 ||
        typeof state.enabled !== "boolean"
      )
        throw Error("Cookie存储元数据无效");
      if (expectedRevision !== undefined && expectedRevision !== state.revision)
        throw Error("Cookie已有其他修改，请重新加载");
      const jar = restore(state.cookies),
        result = await fn(state, jar);
      throwIfInactive(controls);
      if (write && result !== false) {
        state.cookies = entries(jar);
        if (state.cookies.length > maximum) throw Error("Cookie最多500项");
        state.revision++;
        const text = JSON.stringify(state);
        if (Buffer.byteLength(text) > 2 * 1024 * 1024)
          throw Error("Cookie存储超过2MiB");
        temporary = this.file + "." + randomUUID() + ".tmp";
        throwIfInactive(controls);
        await writeFile(temporary, text, { mode: 0o600 });
        // Await our write before cleanup. Never leave an abandoned write that
        // could recreate a removed temp file or publish after cancellation.
        throwIfInactive(controls);
        await rename(temporary, this.file);
        temporary = null;
        // Atomic rename is the commit point; cancellation cannot roll it back.
        throwIfInactive(controls);
      }
      return result;
    } finally {
      try {
        if (temporary) await rm(temporary, { force: true });
      } finally {
        await release();
      }
      throwIfInactive(controls);
    }
  }
  inspect() {
    return this.transact((state, jar) => ({
      enabled: state.enabled,
      revision: state.revision,
      cookies: entries(jar),
    }));
  }
  async configure({ enabled, expectedRevision }) {
    if (typeof enabled !== "boolean" || !Number.isSafeInteger(expectedRevision))
      throw Error("Cookie设置需要开关及版本");
    return this.transact(
      (state) => {
        state.enabled = enabled;
      },
      { write: true, expectedRevision },
    );
  }
  async header(url, controls = {}) {
    url = httpURL(url);
    return this.transact(
      (state, jar) => (state.enabled ? jar.getCookieStringSync(url) : null),
      controls,
    );
  }
  async capture(url, headers, controls = {}) {
    url = httpURL(url);
    throwIfInactive(controls);
    if (headers === undefined) return Promise.resolve();
    const rows = Array.isArray(headers) ? headers : [headers];
    if (rows.length > 100) return Promise.resolve();
    return this.transact(
      (state, jar) => {
        if (!state.enabled) return false;
        for (const line of rows) {
          if (typeof line !== "string" || Buffer.byteLength(line) > 4096)
            continue;
          try {
            storeCookie(jar, line, url);
          } catch {
            /* Invalid server cookies must not discard a valid HTTP response. */
          }
        }
      },
      { ...controls, write: true },
    );
  }
  async setCookie(url, line, { expectedRevision }) {
    url = httpURL(url);
    if (
      typeof line !== "string" ||
      Buffer.byteLength(line) > 4096 ||
      !Number.isSafeInteger(expectedRevision)
    )
      throw Error("Cookie输入无效或超过4KiB");
    return this.transact(
      (state, jar) => {
        storeCookie(jar, line, url);
      },
      { write: true, expectedRevision },
    );
  }
  async remove({ domain, path: cookiePath, key, expectedRevision }) {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      [domain, cookiePath, key].some((value) => typeof value !== "string")
    )
      throw Error("Cookie删除参数无效");
    return this.transact(
      (state, jar) =>
        new Promise((resolve, reject) =>
          jar.store.removeCookie(domain, cookiePath, key, (error) =>
            error ? reject(error) : resolve(),
          ),
        ),
      { write: true, expectedRevision },
    );
  }
  async clear({ expectedRevision }) {
    if (!Number.isSafeInteger(expectedRevision))
      throw Error("Cookie清空需要版本");
    return this.transact((state, jar) => jar.removeAllCookies(), {
      write: true,
      expectedRevision,
    });
  }
}

export function projectCookieSession(store, project, environmentId) {
  return new ProjectCookieJar(
    store.root,
    project.id,
    selectedEnvironment(project, environmentId).id,
  );
}

/** Per-iteration copy for load tests; never writes the user's persistent jar. */
export function memoryCookieSession(state) {
  if (!state) return undefined;
  const jar = restore(structuredClone(state.cookies));
  return {
    async header(url, controls = {}) {
      throwIfInactive(controls);
      return state.enabled ? jar.getCookieStringSync(httpURL(url)) : null;
    },
    async capture(url, headers, controls = {}) {
      throwIfInactive(controls);
      if (!state.enabled || headers === undefined) return;
      url = httpURL(url);
      const rows = Array.isArray(headers) ? headers : [headers];
      if (rows.length > 100) return;
      for (const line of rows) {
        if (typeof line !== "string" || Buffer.byteLength(line) > 4096)
          continue;
        try {
          storeCookie(jar, line, url);
        } catch {}
      }
      if (entries(jar).length > maximum) throw Error("Cookie最多500项");
    },
  };
}
