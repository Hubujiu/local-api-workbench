import fs from "node:fs/promises";
import { constants } from "node:fs";
import { MCPDatabaseGrants } from "./mcp-database-grants.mjs";
import { assertDatabaseBindingRequirements } from "./database-sessions.mjs";
import { databaseSSHConfig } from "./database-ssh.mjs";

const MAX_BYTES = 1024 * 1024,
  MAX_GRANTS = 20,
  nativeId = /^apipost-[a-f0-9]{20}-db-[a-f0-9]{20}$/,
  unsafeKeys = new Set(["__proto__", "prototype", "constructor"]),
  configFields = new Set([
    "type",
    "filename",
    "host",
    "port",
    "user",
    "password",
    "database",
    "ca",
    "authSource",
    "ssl",
    "ssh",
  ]),
  types = new Set([
    "sqlite",
    "postgres",
    "mysql",
    "redis",
    "mongodb",
    "clickhouse",
  ]);

const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identifier = (value) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  value.isWellFormed() &&
  Buffer.byteLength(value) <= 200 &&
  !/[\x00-\x1f\x7f]/.test(value) &&
  !unsafeKeys.has(value);
const invalid = () => {
  const error = Error(
    "MCP stdio 临时数据库授权无效或文件不可读取；未回显路径、输入或凭据",
  );
  error.code = "MCP_STDIO_DATABASE_GRANTS_INVALID";
  return error;
};
function requireValue(condition) {
  if (!condition) throw invalid();
}

function checkStat(stat) {
  requireValue(
    stat.isFile() && stat.size > 0n && stat.size <= BigInt(MAX_BYTES),
  );
  // POSIX mode checks do not claim to validate Windows ACLs. We never chmod,
  // delete, or rewrite an owner's credential file.
  if (process.platform !== "win32" && typeof process.getuid === "function")
    requireValue(
      stat.uid === BigInt(process.getuid()) && !(stat.mode & 0o077n),
    );
}
function sameStat(left, right) {
  return [
    "dev",
    "ino",
    "size",
    "mtimeNs",
    "ctimeNs",
    "mode",
    "uid",
    "nlink",
  ].every((key) => left[key] === right[key]);
}
async function readSnapshot(filename) {
  requireValue(
    typeof filename === "string" &&
      filename.length > 0 &&
      filename.length <= 4096 &&
      filename.isWellFormed() &&
      !filename.includes("\0") &&
      // No UNC/network or Windows device namespace credential sources.
      !filename.replaceAll("\\", "/").startsWith("//"),
  );
  if (process.platform === "win32") {
    const withoutDrive = filename.replace(/^[A-Za-z]:[\\/]/, "");
    requireValue(
      !withoutDrive.includes(":") &&
        !withoutDrive
          .split(/[\\/]/)
          .some((part) =>
            /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(
              part.replace(/[ .]+$/, ""),
            ),
          ),
    );
  }
  const before = await fs.lstat(filename, { bigint: true });
  checkStat(before); // Reject symlinks, directories, and FIFOs before open.
  const file = await fs.open(
    filename,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW || 0) |
      (constants.O_NONBLOCK || 0),
  );
  try {
    const opened = await file.stat({ bigint: true });
    checkStat(opened);
    requireValue(sameStat(before, opened));
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    for (;;) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        Math.min(65536, buffer.length - size),
        size,
      );
      size += bytesRead;
      requireValue(size <= MAX_BYTES);
      if (bytesRead === 0) break;
    }
    const after = await file.stat({ bigint: true }),
      pathAfter = await fs.lstat(filename, { bigint: true });
    checkStat(after);
    checkStat(pathAfter);
    requireValue(
      sameStat(opened, after) &&
        sameStat(opened, pathAfter) &&
        BigInt(size) === opened.size,
    );
    // Fatal decoding rejects replacement-character recovery. Preserve a BOM so
    // JSON.parse rejects it instead of silently accepting another file format.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, size),
    );
  } finally {
    await file.close();
  }
}

function parseSnapshot(text) {
  const value = JSON.parse(text);
  // JSON.parse owns grammar validation; this bounded token walk additionally
  // rejects duplicate (including escaped-equivalent) keys and deep objects.
  const stack = [];
  let tokens = 0;
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]/g)) {
    requireValue(++tokens <= 8192);
    const token = match[0],
      parent = stack.at(-1);
    if (token[0] === '"') {
      const string = JSON.parse(token);
      requireValue(string.isWellFormed());
      if (parent?.keys && parent.key) {
        requireValue(!unsafeKeys.has(string) && !parent.keys.has(string));
        parent.keys.add(string);
        parent.key = false;
      }
    } else if (token === "{" || token === "[") {
      stack.push(token === "{" ? { keys: new Set(), key: true } : {});
      requireValue(stack.length <= 8);
    } else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && parent?.keys) parent.key = true;
  }
  return value;
}

function prepareConfig(input) {
  requireValue(
    plain(input) &&
      Object.keys(input).every((key) => configFields.has(key)) &&
      types.has(input.type),
  );
  const config = structuredClone(input);
  for (const key of [
    "filename",
    "host",
    "user",
    "password",
    "database",
    "ca",
    "authSource",
  ])
    if (Object.hasOwn(config, key))
      requireValue(
        typeof config[key] === "string" &&
          config[key].isWellFormed() &&
          !config[key].includes("\0") &&
          Buffer.byteLength(config[key]) <= 65536,
      );
  if (config.type === "sqlite") {
    requireValue(
      Object.keys(config).every((key) => ["type", "filename"].includes(key)) &&
        typeof config.filename === "string" &&
        !!config.filename.trim(),
    );
  } else {
    requireValue(
      !Object.hasOwn(config, "filename") &&
        typeof config.host === "string" &&
        !!config.host.trim() &&
        typeof config.database === "string" &&
        !!config.database.trim(),
    );
    if (config.type === "postgres")
      requireValue(typeof config.user === "string" && !!config.user.trim());
    if (Object.hasOwn(config, "port"))
      requireValue(
        Number.isInteger(config.port) &&
          config.port >= 1 &&
          config.port <= 65535,
      );
    if (Object.hasOwn(config, "ssl"))
      requireValue(typeof config.ssl === "boolean");
    if (Object.hasOwn(config, "authSource"))
      requireValue(config.type === "mongodb" && !!config.authSource.trim());
    if (Object.hasOwn(config, "ssh")) {
      requireValue(["postgres", "mysql"].includes(config.type));
      config.ssh = databaseSSHConfig(config.ssh);
    }
  }
  requireValue(
    Buffer.byteLength(
      JSON.stringify({ ...config, ssl: config.ssl === true }),
    ) <= 131072,
  );
  return config;
}

/**
 * Explicit owner startup file, read exactly once; never a model-callable grant.
 * Envelope: { version: 1, projects: [{ projectId, databaseConnections: { alias: config } }] }.
 * databaseConnections uses the CLI connection mapping, not persisted project data.
 * Native aliases are registered as bindingId, retaining dynamic catalog checks.
 * File changes/deletion do not revoke loaded grants; close() does. A subsequent
 * invocation supplying the file is an explicit new grant. PG ambient isolation
 * is provided by the shared PostgreSQL client factory, not this input validator.
 */
export async function loadMCPStdioDatabaseGrants(
  filename,
  { projects, write, execute, resolveProject } = {},
) {
  let grants;
  try {
    requireValue(
      write === true &&
        execute === true &&
        Array.isArray(projects) &&
        projects.length > 0 &&
        projects.length <= 100 &&
        projects.every(identifier) &&
        new Set(projects).size === projects.length &&
        typeof resolveProject === "function",
    );
    const allowedProjects = [...projects],
      document = parseSnapshot(await readSnapshot(filename));
    requireValue(
      plain(document) &&
        Object.keys(document).every((key) =>
          ["version", "projects"].includes(key),
        ) &&
        document.version === 1 &&
        Array.isArray(document.projects) &&
        document.projects.length > 0 &&
        document.projects.length <= MAX_GRANTS,
    );
    const seen = new Set(),
      entries = [];
    // Complete structural/configuration preflight before resolving projects or
    // registering any connection. No connection opens during registration.
    for (const entry of document.projects) {
      requireValue(
        plain(entry) &&
          Object.keys(entry).every((key) =>
            ["projectId", "databaseConnections"].includes(key),
          ) &&
          identifier(entry.projectId) &&
          allowedProjects.includes(entry.projectId) &&
          !seen.has(entry.projectId) &&
          plain(entry.databaseConnections),
      );
      seen.add(entry.projectId);
      const connections = Object.entries(entry.databaseConnections);
      requireValue(
        connections.length > 0 &&
          entries.length + connections.length <= MAX_GRANTS,
      );
      for (const [alias, input] of connections) {
        requireValue(identifier(alias));
        // Malformed imported-looking identifiers cannot be downgraded to
        // ordinary aliases and thereby skip current-source policy checks.
        requireValue(!alias.startsWith("apipost-") || nativeId.test(alias));
        entries.push({
          projectId: entry.projectId,
          alias,
          config: prepareConfig(input),
        });
      }
    }
    const snapshots = new Map();
    for (const projectId of seen) {
      const project = await resolveProject(projectId);
      requireValue(
        plain(project) && project.id === projectId && !project.archived,
      );
      // Only identity/catalog are retained. Project credentials are never read
      // or merged into explicit owner configs.
      const catalog = project.settings?.apipostDatabases;
      snapshots.set(projectId, {
        id: projectId,
        settings: {
          apipostDatabases: Array.isArray(catalog)
            ? catalog.map((source) => ({
                id: source?.id,
                type: source?.type,
                ...(source?.requiresSSH !== undefined
                  ? { requiresSSH: source.requiresSSH }
                  : {}),
              }))
            : undefined,
        },
      });
    }
    for (const { projectId, alias, config } of entries) {
      if (!nativeId.test(alias)) continue;
      const catalog = snapshots.get(projectId).settings.apipostDatabases;
      requireValue(Array.isArray(catalog) && catalog.length <= 100);
      const sources = catalog.filter((source) => source?.id === alias);
      requireValue(sources.length === 1 && plain(sources[0]));
      assertDatabaseBindingRequirements(sources[0], config);
      if (sources[0].requiresSSH === true)
        requireValue(["postgres", "mysql"].includes(sources[0].type));
    }
    grants = new MCPDatabaseGrants(
      () => ({
        enabled: true,
        write: true,
        execute: true,
        projects: allowedProjects,
      }),
      resolveProject,
    );
    const epoch = grants.capture(),
      bindings = new Map();
    for (const { projectId, alias, config } of entries) {
      const connection = grants.register(
        snapshots.get(projectId),
        {
          ...config,
          name: "MCP stdio transient",
          ...(nativeId.test(alias) ? { bindingId: alias } : {}),
        },
        epoch,
      );
      if (!bindings.has(projectId)) bindings.set(projectId, new Map());
      bindings.get(projectId).set(alias, connection.id);
    }
    let closed = false;
    return Object.freeze({
      async query(projectId, operation, signal) {
        const connectionId = bindings
          .get(projectId)
          ?.get(operation?.connectionId);
        if (closed || !connectionId)
          throw Error("MCP stdio 数据库连接未获本次授权或已关闭");
        return grants.query(
          epoch,
          projectId,
          { ...operation, connectionId },
          signal,
        );
      },
      close() {
        closed = true;
        bindings.clear();
        grants.invalidate();
      },
    });
  } catch {
    grants?.invalidate();
    throw invalid(); // Never attach filesystem/parser/driver causes or input.
  }
}
