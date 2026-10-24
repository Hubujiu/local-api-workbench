import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export async function loadMCPConfig(root) {
  try {
    const value = JSON.parse(
      await readFile(path.join(root, ".mcp-config.json"), "utf8"),
    );
    if (value.remember !== true) return null;
    if (
      !Array.isArray(value.projects) ||
      value.projects.some((id) => typeof id !== "string") ||
      (value.enabled && !/^[a-f0-9]{64}$/.test(value.token)) ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535
    )
      throw Error("MCP持久配置格式无效");
    return {
      enabled: value.enabled === true,
      remember: true,
      projects: value.projects,
      write: value.write === true,
      execute: value.write === true && value.execute === true,
      token: value.enabled ? value.token : "",
      port: value.port,
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { warning: "MCP配置无法安全读取，已禁用服务。请重新授权。" };
  }
}
export async function saveMCPConfig(root, config) {
  const ignorePath = path.join(root, ".gitignore");
  let ignore = "";
  try {
    ignore = await readFile(ignorePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const patterns = [".mcp-config.json", ".mcp-config.json.*.tmp"];
  const missing = patterns.filter(
    (pattern) => !ignore.split(/\r?\n/).includes(pattern),
  );
  if (missing.length)
    await writeFile(
      ignorePath,
      ignore +
        (ignore && !ignore.endsWith("\n") ? "\n" : "") +
        missing.join("\n") +
        "\n",
    );
  const value = config.remember
    ? config
    : {
        remember: false,
        enabled: false,
        projects: [],
        write: false,
        execute: false,
        token: "",
      };
  const target = path.join(root, ".mcp-config.json"),
    temporary = target + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, target);
}
