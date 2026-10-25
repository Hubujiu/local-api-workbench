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
    return {
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
    this.running = null;
    this.controller = null;
    this.closed = false;
    this.warning = "";
    this.timer = setInterval(() => {
      this.tick().catch(() => {
        this.warning = "当前项目配置不可用，自动同步已停止";
        void this.deactivate();
      });
    }, 1000);
    this.timer.unref();
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
    this.controller?.abort();
    await this.running?.catch(() => {});
    return this.snapshot();
  }
  async activate(projectId) {
    if (this.closed) throw Error("自动导入服务已关闭");
    const stop = this.deactivate();
    const epoch = this.epoch;
    await stop;
    const p = await this.store.get(projectId);
    if (epoch !== this.epoch || this.closed) throw Error("项目激活已取消");
    if (p.archived) throw Error("归档项目不能自动导入");
    const sources = definitions(p);
    this.active = projectId;
    this.warning = "";
    for (const source of sources)
      if (source.enabled) {
        this.next.set(source.id, this.now() + source.intervalSeconds * 1000);
        this.signatures.set(source.id, signature(source));
      }
    return this.snapshot();
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
          auth: { type: "none" },
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
