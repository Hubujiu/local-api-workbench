import { validateHeaderName, validateHeaderValue } from "node:http";
import { parse as parseYAML } from "yaml";
import { syncMCPOpenAPI } from "./mcp-openapi-sync.mjs";

export function normalizeAutoImports(value = []) {
  if (!Array.isArray(value) || value.length > 10)
    throw Error("自动导入最多10个数据源");
  const ids = new Set();
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (k) =>
          ![
            "id",
            "name",
            "url",
            "enabled",
            "intervalSeconds",
            "folder",
            "coverMode",
            "authType",
          ].includes(k),
      )
    )
      throw Error("自动导入字段无效");
    if (
      typeof item.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) ||
      ids.has(item.id)
    )
      throw Error("自动导入标识无效或重复");
    ids.add(item.id);
    if (
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 100
    )
      throw Error("自动导入名称无效");
    if (typeof item.url !== "string" || item.url.length > 8192)
      throw Error("数据源URL无效");
    const url = new URL(item.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw Error("数据源须为不含凭据或片段的HTTP(S)地址");
    if (
      typeof item.enabled !== "boolean" ||
      !Number.isInteger(item.intervalSeconds) ||
      item.intervalSeconds < 60 ||
      item.intervalSeconds > 86400
    )
      throw Error("同步开关或间隔无效，间隔须为60至86400秒");
    const folder = item.folder ?? "",
      coverMode = item.coverMode ?? "url_and_folder";
    if (
      typeof folder !== "string" ||
      folder.length > 500 ||
      !["url", "url_and_folder", "ignore"].includes(coverMode)
    )
      throw Error("同步目录或覆盖方式无效");
    if (
      item.authType !== undefined &&
      !["none", "basic", "bearer", "apiKey"].includes(item.authType)
    )
      throw Error("数据源认证类型无效");
    return {
      ...(item.authType === undefined ? {} : { authType: item.authType }),
      id: item.id,
      name: item.name,
      url: url.href,
      enabled: item.enabled,
      intervalSeconds: item.intervalSeconds,
      folder,
      coverMode,
    };
  });
}
// Source credentials are process-local activation grants, never project fields.
function sourceCredentials(sources, value = {}) {
  const plain = (v) =>
    v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype;
  const invalid = () => {
    throw Error("数据源临时凭据无效、缺失或与配置不匹配");
  };
  if (!plain(value) || Object.keys(value).length > 10) invalid();
  const result = new Map();
  for (const id of Object.keys(value)) {
    const source = sources.find((s) => s.id === id && s.enabled);
    const auth = value[id];
    if (
      !source ||
      !plain(auth) ||
      !Object.hasOwn(auth, "type") ||
      auth.type !== source.authType
    )
      invalid();
    const fields = {
      basic: ["type", "username", "password"],
      bearer: ["type", "token"],
      apiKey: ["type", "in", "key", "value"],
    }[auth.type];
    if (
      !fields ||
      Object.keys(auth).length !== fields.length ||
      fields.some(
        (k) =>
          !Object.hasOwn(auth, k) ||
          typeof auth[k] !== "string" ||
          Buffer.byteLength(auth[k]) > 8192,
      ) ||
      Object.keys(auth).some((k) => !fields.includes(k))
    )
      invalid();
    if (
      auth.type === "basic" &&
      (auth.username.includes(":") ||
        /[\r\n\0]/.test(auth.username + auth.password))
    )
      invalid();
    try {
      if (auth.type === "bearer") {
        if (!auth.token) invalid();
        validateHeaderValue("authorization", "Bearer " + auth.token);
      }
      if (auth.type === "apiKey") {
        if (
          auth.in !== "header" ||
          !auth.value ||
          [
            "host",
            "content-length",
            "transfer-encoding",
            "connection",
            "upgrade",
            "expect",
            "trailer",
            "te",
            "proxy-authorization",
            "cookie",
            "set-cookie",
          ].includes(auth.key.toLowerCase())
        )
          invalid();
        validateHeaderName(auth.key);
        validateHeaderValue(auth.key, auth.value);
      }
    } catch {
      invalid();
    }
    result.set(id, {
      signature: signature(source),
      auth: structuredClone(auth),
    });
  }
  for (const source of sources)
    if (
      source.enabled &&
      source.authType &&
      source.authType !== "none" &&
      !result.has(source.id)
    )
      invalid();
  return result;
}
const definitions = (p) => normalizeAutoImports(p.settings?.autoImports);
const signature = (d) => JSON.stringify(d);
const record = (p, entry) => {
  p.settings ??= {};
  p.settings.autoImportRuns = [
    entry,
    ...(Array.isArray(p.settings.autoImportRuns)
      ? p.settings.autoImportRuns
      : []),
  ].slice(0, 20);
};

export class ActiveProjectImports {
  constructor({ store, request, now = Date.now }) {
    this.store = store;
    this.request = request;
    this.now = now;
    this.active = null;
    this.epoch = 0;
    this.next = new Map();
    this.signatures = new Map();
    this.credentials = new Map();
    this.running = null;
    this.controller = null;
    this.closed = false;
    this.warning = "";
    this.timer = setInterval(() => {
      void this.poll();
    }, 1000);
    this.timer.unref();
  }
  async poll() {
    const projectId = this.active,
      epoch = this.epoch;
    try {
      await this.tick();
    } catch {
      // A delayed read failure belongs to the activation that started it.
      // It must not revoke a newer activation, even of the same project.
      if (this.active !== projectId || this.epoch !== epoch || this.closed)
        return;
      this.warning = "当前项目配置不可用，自动同步已停止";
      await this.deactivate();
    }
  }
  snapshot() {
    return {
      warning: this.warning,
      projectId: this.active,
      running: !!this.running,
      nextRuns: [...this.next].map(([sourceId, at]) => ({ sourceId, at })),
    };
  }
  async deactivate(projectId) {
    if (projectId !== undefined && projectId !== this.active)
      return this.snapshot();
    this.epoch++;
    this.active = null;
    this.next.clear();
    this.signatures.clear();
    this.credentials.clear();
    this.controller?.abort();
    await this.running?.catch(() => {});
    return this.snapshot();
  }
  async activate(projectId, credentials = {}) {
    if (this.closed) throw Error("自动导入服务已关闭");
    const stop = this.deactivate();
    const epoch = this.epoch;
    await stop;
    const p = await this.store.get(projectId);
    if (epoch !== this.epoch || this.closed) throw Error("项目激活已取消");
    if (p.archived) throw Error("归档项目不能自动导入");
    const sources = definitions(p);
    const bindings = sourceCredentials(sources, credentials);
    this.credentials = bindings;
    this.active = projectId;
    this.warning = "";
    for (const source of sources)
      if (source.enabled) {
        this.next.set(source.id, this.now() + source.intervalSeconds * 1000);
        this.signatures.set(source.id, signature(source));
      }
    return this.snapshot();
  }
  async reactivate(projectId) {
    const p = await this.store.get(projectId);
    if (
      definitions(p).some(
        (s) => s.enabled && s.authType && s.authType !== "none",
      )
    ) {
      await this.deactivate();
      this.warning = "配置已更改，请提供临时凭据重新激活数据源";
      return this.snapshot();
    }
    return this.activate(projectId);
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.deactivate();
  }
  current(projectId, epoch) {
    if (this.closed || this.active !== projectId || this.epoch !== epoch)
      throw Error("当前项目已切换或同步已取消");
  }
  async tick() {
    if (!this.active || this.running || this.closed) return;
    const projectId = this.active,
      epoch = this.epoch;
    const p = await this.store.get(projectId);
    if (this.active !== projectId || this.epoch !== epoch || this.running)
      return;
    if (p.archived) {
      await this.deactivate(projectId);
      return;
    }
    const sources = definitions(p).filter((d) => d.enabled),
      enabled = new Set(sources.map((d) => d.id));
    for (const id of this.next.keys())
      if (!enabled.has(id)) {
        this.next.delete(id);
        this.signatures.delete(id);
      }
    for (const source of sources) {
      const key = signature(source);
      if (this.signatures.get(source.id) !== key) {
        this.signatures.set(source.id, key);
        this.next.set(source.id, this.now() + source.intervalSeconds * 1000);
      }
      if (this.next.get(source.id) <= this.now()) {
        await this.run(projectId, source.id).catch(() => {});
        return;
      }
    }
  }
  async run(projectId, sourceId) {
    if (this.running) throw Error("已有同步正在执行");
    this.current(projectId, this.epoch);
    const epoch = this.epoch;
    const operation = this.execute(projectId, sourceId, epoch);
    this.running = operation;
    try {
      return await operation;
    } finally {
      if (this.running === operation) {
        this.running = null;
        this.controller = null;
      }
    }
  }
  async execute(projectId, sourceId, epoch) {
    const p = await this.store.get(projectId);
    this.current(projectId, epoch);
    const source = definitions(p).find((d) => d.id === sourceId);
    if (p.archived || !source?.enabled) throw Error("数据源未启用或项目已归档");
    const key = signature(source);
    const binding = this.credentials.get(sourceId);
    if (
      source.authType &&
      source.authType !== "none" &&
      (!binding || binding.signature !== key)
    ) {
      this.warning = "数据源凭据已失效，请重新激活";
      this.active = null;
      this.epoch++;
      this.next.clear();
      this.signatures.clear();
      this.credentials.clear();
      throw Error(this.warning);
    }
    const auth =
      binding?.signature === key
        ? structuredClone(binding.auth)
        : { type: "none" };
    this.next.set(sourceId, this.now() + source.intervalSeconds * 1000);
    this.signatures.set(sourceId, key);
    const controller = new AbortController();
    this.controller = controller;
    let writeAttempted = false;
    const entry = {
      sourceId,
      startedAt: new Date(this.now()).toISOString(),
      status: "failed",
      imported: 0,
    };
    try {
      const response = await this.request(
        {
          url: source.url,
          method: "GET",
          timeout: 15000,
          auth,
        },
        controller.signal,
      );
      if (response.status < 200 || response.status >= 300)
        throw Error("数据源HTTP状态不是2xx: " + response.status);
      this.current(projectId, epoch);
      const document = parseYAML(response.body, {
        maxAliasCount: 100,
        uniqueKeys: true,
      });
      const current = await this.store.get(projectId);
      this.current(projectId, epoch);
      if (
        current.archived ||
        signature(definitions(current).find((d) => d.id === sourceId)) !== key
      )
        throw Error("同步配置已变化，结果未写入");
      const imported = syncMCPOpenAPI(current, {
        document,
        folder: source.folder,
        coverMode: source.coverMode,
      });
      this.current(projectId, epoch);
      entry.status = "success";
      entry.imported = imported.length;
      entry.finishedAt = new Date(this.now()).toISOString();
      record(current, entry);
      writeAttempted = true;
      await this.store.save(current, { signal: controller.signal });
      return structuredClone(entry);
    } catch (error) {
      if (writeAttempted && error.code !== "STORE_SAVE_ABORTED") {
        // A failed acknowledgement does not establish whether the atomic write
        // committed. Stop this session instead of retrying on the next interval.
        this.warning =
          "保存结果需重新加载核实，自动同步已停止；请检查后重新激活";
        this.active = null;
        this.epoch++;
        this.next.clear();
        this.signatures.clear();
        this.credentials.clear();
      }
      if (
        !writeAttempted &&
        this.active === projectId &&
        this.epoch === epoch &&
        !this.closed
      ) {
        try {
          const current = await this.store.get(projectId);
          if (
            this.active === projectId &&
            this.epoch === epoch &&
            !current.archived &&
            signature(definitions(current).find((d) => d.id === sourceId)) ===
              key
          ) {
            entry.finishedAt = new Date(this.now()).toISOString();
            // Do not persist fetched source text, transport details or arbitrary error objects.
            entry.message = "同步请求、文档解析或导入失败；项目接口保持不变";
            record(current, entry);
            await this.store.save(current, { activity: true });
          }
        } catch {
          /* Preserve the original error; do not retry uncertain writes. */
        }
      }
      throw error;
    }
  }
}
