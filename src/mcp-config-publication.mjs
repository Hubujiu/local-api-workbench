// One application's policy ordering, including memory publication. File rename
// alone cannot prevent an older remembered snapshot from restoring a revoked key.
export class MCPConfigPublication {
  #tail = Promise.resolve();
  #revocation = 0;
  constructor({ identity, snapshot, write }) {
    this.identity = identity;
    this.snapshot = snapshot;
    this.write = write;
  }
  run(operation) {
    const task = this.#tail.then(operation);
    this.#tail = task.catch(() => {});
    return task;
  }
  captureRevocation() {
    return this.#revocation;
  }
  advanceRevocation() {
    return ++this.#revocation;
  }
  assertRevocation(generation) {
    if (generation !== this.#revocation)
      throw Error("MCP授权更新已被较新的减权请求替代，不能重新发布旧权限");
  }
  persist(identity) {
    return this.run(async () => {
      // An old dispatcher retains its own project array. Never promote it into
      // a policy the owner has since replaced, even if the token is unchanged.
      if (this.identity() !== identity) return false;
      const snapshot = this.snapshot();
      if (snapshot === null) return false;
      await this.write(snapshot);
      return true;
    });
  }
}

// Only already-authorized subsets qualify. Rotation, retention changes and
// mixed grants retain the fully validated ordered publication path.
export function immediateMCPReduction(current, config) {
  if (
    !config ||
    !["enabled", "remember", "write", "execute"].every(
      (key) => typeof config[key] === "boolean",
    ) ||
    (config.rotate !== undefined && config.rotate !== false) ||
    config.remember !== current.remember ||
    !Array.isArray(config.projects) ||
    config.projects.some(
      (id) => typeof id !== "string" || !current.projects.includes(id),
    ) ||
    new Set(config.projects).size !== config.projects.length ||
    (config.enabled && !current.enabled) ||
    (config.write && !current.write) ||
    (config.write && config.execute && !current.execute)
  )
    return null;
  if (
    config.enabled === current.enabled &&
    config.write === current.write &&
    (config.write && config.execute) === current.execute &&
    config.projects.length === current.projects.length
  )
    return null;
  return {
    enabled: config.enabled,
    remember: config.remember,
    projects: [...config.projects],
    write: config.write,
    execute: config.write && config.execute,
  };
}
