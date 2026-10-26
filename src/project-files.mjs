import { ProjectCommitUncertain } from "./project-commit-outcome.mjs";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
const groups = {
  requests: "apis",
  environments: "envs",
  plans: "plans",
  cases: "cases",
  protocols: "protocols",
};
const filename = (id) => {
  if (typeof id !== "string" || !id || id.length > 200)
    throw Error("记录ID无效");
  return (
    (/^[a-f0-9-]{36}$/i.test(id)
      ? id
      : "key-" + Buffer.from(id).toString("base64url")) + ".json"
  );
};
function validateLayout(project) {
  for (const key of Object.keys(groups)) {
    const values = project[key] || [];
    if (!Array.isArray(values)) throw Error("项目集合格式无效");
    if (new Set(values.map((item) => item?.id)).size !== values.length)
      throw Error("项目记录ID重复");
    for (const item of values) filename(item?.id);
  }
}
async function writeJSON(file, value) {
  const text = JSON.stringify(value, null, 2) + "\n";
  try {
    if ((await readFile(file, "utf8")) === text) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, file);
}
async function apply(directory, project) {
  const metadata = { ...project, storageFormat: 2, collections: {} };
  delete metadata._diskFingerprint;
  for (const [key, folder] of Object.entries(groups)) {
    const values = project[key] || [];
    if (!Array.isArray(values)) throw Error("项目集合格式无效");
    if (new Set(values.map((item) => item.id)).size !== values.length)
      throw Error("项目记录ID重复");
    metadata.collections[key] = values.map((item) => item.id);
    delete metadata[key];
    const target = path.join(directory, folder);
    await mkdir(target, { recursive: true });
    const expected = new Set(
      folder === "envs" ? ["globals.json", "servers.json"] : [],
    );
    for (const item of values) {
      const name = filename(item.id);
      expected.add(name);
      await writeJSON(path.join(target, name), item);
    }
    for (const name of await readdir(target))
      if (name.endsWith(".json") && !expected.has(name))
        await rm(path.join(target, name));
  }
  for (const [key, file] of Object.entries({
    settings: "settings/project.json",
    globalVariables: "envs/globals.json",
    servers: "envs/servers.json",
    history: "history/requests.json",
    runs: "history/runs.json",
    protocolRuns: "history/protocols.json",
    documents: "settings/documents.json",
    dictionary: "settings/dictionary.json",
    parameterDictionary: "settings/parameter-dictionary.json",
    folders: "settings/folders.json",
  })) {
    await writeJSON(
      path.join(directory, file),
      project[key] ?? (["settings", "globalVariables"].includes(key) ? {} : []),
    );
    delete metadata[key];
  }
  await writeJSON(path.join(directory, "project.json"), metadata);
  try {
    await writeFile(
      path.join(directory, ".gitignore"),
      "history/\n.transaction.json\n*.tmp\n",
      { flag: "wx" },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
export async function recoverProject(directory, expectedId) {
  let journal;
  try {
    journal = JSON.parse(
      await readFile(path.join(directory, ".transaction.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (journal.id !== expectedId) throw Error("项目恢复日志ID不匹配");
  validateLayout(journal);
  try {
    await apply(directory, journal);
    await rm(path.join(directory, ".transaction.json"));
  } catch (error) {
    throw new ProjectCommitUncertain(expectedId, error);
  }
}
export async function writeProject(directory, project) {
  validateLayout(project);
  await mkdir(directory, { recursive: true });
  // The complete journal is written before separate files. Reads recover it under the same lock.
  // This covers process interruption, not a promise of power-loss durability.
  await writeJSON(path.join(directory, ".transaction.json"), project);
  try {
    await apply(directory, project);
    await rm(path.join(directory, ".transaction.json"));
  } catch (error) {
    throw new ProjectCommitUncertain(project.id, error);
  }
}
export async function readProject(directory, expectedId) {
  await recoverProject(directory, expectedId);
  const metadata = JSON.parse(
    await readFile(path.join(directory, "project.json"), "utf8"),
  );
  if (metadata.id !== expectedId || metadata.storageFormat !== 2)
    throw Error("项目清单格式或ID无效");
  const project = { ...metadata };
  for (const [key, folder] of Object.entries(groups)) {
    const ids = metadata.collections?.[key] || [];
    if (!Array.isArray(ids) || ids.length > 10000)
      throw Error("项目集合清单无效");
    project[key] = await Promise.all(
      ids.map(async (id) => {
        const item = JSON.parse(
          await readFile(path.join(directory, folder, filename(id)), "utf8"),
        );
        if (item.id !== id) throw Error("项目记录ID与清单不一致");
        return item;
      }),
    );
  }
  for (const [key, file] of Object.entries({
    settings: "settings/project.json",
    globalVariables: "envs/globals.json",
    servers: "envs/servers.json",
    history: "history/requests.json",
    runs: "history/runs.json",
    protocolRuns: "history/protocols.json",
    documents: "settings/documents.json",
    dictionary: "settings/dictionary.json",
    parameterDictionary: "settings/parameter-dictionary.json",
    folders: "settings/folders.json",
  })) {
    try {
      project[key] = JSON.parse(
        await readFile(path.join(directory, file), "utf8"),
      );
    } catch (error) {
      if (
        error.code === "ENOENT" &&
        ["history", "runs", "protocolRuns", "parameterDictionary"].includes(key)
      )
        project[key] = [];
      else throw error;
    }
  }
  delete project.storageFormat;
  delete project.collections;
  project._diskFingerprint = projectFingerprint(project);
  return project;
}

export function projectFingerprint(project) {
  const copy = { ...project };
  for (const key of [
    "_diskFingerprint",
    "revision",
    "updatedAt",
    "history",
    "runs",
    "protocolRuns",
  ])
    delete copy[key];
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  return createHash("sha256")
    .update(JSON.stringify(canonical(copy)))
    .digest("hex");
}
