import path from "node:path";
import { Store } from "./runtime.mjs";
import { loadMCPStdioDatabaseGrants } from "./mcp-stdio-database-grants.mjs";

// Only the owner-controlled process arguments may opt into a grants file.
export function parseMCPStdioArguments(argv) {
  const projects = [];
  let write = false,
    execute = false,
    filename;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") write = true;
    else if (arg === "--execute") execute = true;
    else if (arg === "--project" || arg === "--database-grants-file") {
      const value = argv[++i];
      if (
        typeof value !== "string" ||
        !value ||
        value.startsWith("--") ||
        !value.isWellFormed() ||
        value.includes("\0")
      )
        throw Error("MCP stdio startup arguments invalid");
      if (arg === "--project") {
        if (!projects.includes(value)) projects.push(value);
      } else {
        if (filename !== undefined)
          throw Error("MCP stdio startup arguments invalid");
        filename = value;
      }
    } else throw Error("MCP stdio startup arguments invalid");
  }
  if (filename !== undefined && (!write || !execute || !projects.length))
    throw Error(
      "MCP stdio database grants require explicit project/write/execute",
    );
  return { projects, write, execute, filename };
}

export async function createMCPStdioContext(argv, root) {
  const options = parseMCPStdioArguments(argv);
  const store = new Store(path.resolve(root || ".local-api"));
  await store.init();
  const grants =
    options.filename === undefined
      ? undefined
      : await loadMCPStdioDatabaseGrants(options.filename, {
          projects: [...options.projects],
          write: options.write,
          execute: options.execute,
          resolveProject: (id) => store.get(id),
        });
  return {
    store,
    projects: [...options.projects],
    write: options.write,
    execute: options.execute,
    databaseExecutor: grants
      ? (projectId, operation, signal) =>
          grants.query(projectId, operation, signal)
      : undefined,
    close: () => grants?.close(),
  };
}
