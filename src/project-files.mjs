import { validateLoadRuns } from "./load-report-evidence.mjs";
import { ProjectCommitUncertain } from "./project-commit-outcome.mjs";
import { validateRequestDefinitionHistory } from "./request-definition-history.mjs";
import {
  lstat,
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
  if (typeof id !== "string" || !id || id.length > 200 || !id.isWellFormed())
    throw Error("记录ID无效");
  const name =
    (/^[a-f0-9-]{36}$/i.test(id)
      ? id
      : "key-" + Buffer.from(id).toString("base64url")) + ".json";
  // Atomic writes add "." + a 36-character UUID + ".tmp". Validate the
  // complete component before publishing a journal, on every supported OS.
  if (Buffer.byteLength(name) + 41 > 255)
    throw Error("记录ID编码后的文件名过长");
  return name;
};
function validateLayout(project) {
  for (const key of Object.keys(groups)) {
    const values = project[key] || [];
    if (!Array.isArray(values)) throw Error("项目集合格式无效");
    if (new Set(values.map((item) => item?.id)).size !== values.length)
      throw Error("项目记录ID重复");
    const diskNames = new Set();
    for (const item of values) {
      // Encoded names are ASCII; account for case-insensitive filesystems.
      const name = filename(item?.id).toLowerCase();
      if (diskNames.has(name)) throw Error("项目记录ID映射到重复文件名");
      diskNames.add(name);
    }
  }
  // Preserve existing layout diagnostics, then validate history as part of the
  // same pre-publication/pre-recovery gate. Neither check may apply any bytes.
  validateRequestDefinitionHistory(project);
  validateLoadRuns(project.loadRuns === undefined ? [] : project.loadRuns);
}
function writeJSON(file, value, beforePublish, onPublicationPossible) {
  return writeText(
    file,
    JSON.stringify(value, null, 2) + "\n",
    beforePublish,
    onPublicationPossible,
  );
}
async function writeText(file, text, beforePublish, onPublicationPossible) {
  try {
    if ((await readFile(file, "utf8")) === text) {
      onPublicationPossible?.();
      beforePublish?.();
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    // No await between this gate and beginning the atomic journal rename.
    // Cancellation after publication cannot promise rollback.
    beforePublish?.();
    onPublicationPossible?.();
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
const localHistoryFile = ".local-history.json";
const historyFields = ["requestDefinitionHistoryFormat", "loadReportFormat"];
const privateGitRules = [
  "/history/",
  "/.transaction.json",
  "*.tmp",
  "/" + localHistoryFile,
];
async function ensureGitIgnore(directory) {
  const file = path.join(directory, ".gitignore");
  let text;
  try {
    if (!(await lstat(file)).isFile())
      throw Error("项目 Git 忽略规则必须是普通文件");
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    text = "";
  }
  if (
    text.trimEnd().split(/\r?\n/).slice(-privateGitRules.length).join("\n") ===
    privateGitRules.join("\n")
  )
    return;
  await writeText(
    file,
    text +
      (text === "" || text.endsWith("\n") ? "" : "\n") +
      privateGitRules.join("\n") +
      "\n",
  );
}

async function historyManifest(directory, metadata) {
  if (metadata.storageFormat === 2) return metadata;
  if (historyFields.some((key) => Object.hasOwn(metadata, key)))
    throw Error("本地历史清单格式无效");
  let manifest;
  try {
    const file = path.join(directory, localHistoryFile);
    if (!(await lstat(file)).isFile())
      throw Error("本地历史清单必须是普通文件");
    manifest = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // A definitions-only Git clone has neither this local manifest nor its
    // ignored history tree. Missing only the manifest is not a clean clone.
    try {
      await lstat(path.join(directory, "history"));
    } catch (historyError) {
      if (historyError.code === "ENOENT") return {};
      throw historyError;
    }
    throw error;
  }
  if (
    !manifest ||
    manifest.version !== 1 ||
    manifest.projectId !== metadata.id ||
    Object.keys(manifest).some(
      (key) => !["version", "projectId", ...historyFields].includes(key),
    )
  )
    throw Error("本地历史清单格式无效");
  return manifest;
}

async function apply(directory, project) {
  const metadata = { ...project, storageFormat: 3, collections: {} };
  delete metadata._diskFingerprint;
  delete metadata.loadReportFormat;
  delete metadata.requestDefinitionHistory;
  delete metadata.requestDefinitionHistoryFormat;
  const localHistory = { version: 1, projectId: project.id };
  if (project.loadRuns !== undefined) localHistory.loadReportFormat = 1;
  if (project.requestDefinitionHistory !== undefined)
    localHistory.requestDefinitionHistoryFormat = 1;
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
    loadRuns: "history/load-reports.json",
    protocolRuns: "history/protocols.json",
    documents: "settings/documents.json",
    dictionary: "settings/dictionary.json",
    parameterDictionary: "settings/parameter-dictionary.json",
    folders: "settings/folders.json",
  })) {
    if (key === "loadRuns" && project.loadRuns === undefined) {
      await rm(path.join(directory, file), { force: true });
      delete metadata.loadRuns;
      continue;
    }
    await writeJSON(
      path.join(directory, file),
      project[key] ?? (["settings", "globalVariables"].includes(key) ? {} : []),
    );
    delete metadata[key];
  }
  // Keep the established collection/environment-before-history apply order.
  // A history-directory fault still leaves the same partial-apply evidence;
  // the complete journal remains the sole authority for roll-forward.
  if (project.requestDefinitionHistory !== undefined)
    await writeJSON(
      path.join(directory, "history/definitions.json"),
      project.requestDefinitionHistory,
    );
  await ensureGitIgnore(directory);
  await writeJSON(path.join(directory, localHistoryFile), localHistory);
  await writeJSON(path.join(directory, "project.json"), metadata);
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
export async function writeProject(
  directory,
  project,
  { signal, beforePublish } = {},
) {
  const assertNotAborted = () => {
    if (signal?.aborted)
      throw Object.assign(Error("项目保存已取消"), {
        code: "STORE_SAVE_ABORTED",
      });
  };
  assertNotAborted();
  validateLayout(project);
  await mkdir(directory, { recursive: true });
  // The complete journal is written before separate files. Reads recover it under the same lock.
  // This covers process interruption, not a promise of power-loss durability.
  const journal = path.join(directory, ".transaction.json");
  let publicationPossible = false;
  try {
    await writeJSON(
      journal,
      project,
      () => {
        assertNotAborted();
        beforePublish?.();
      },
      () => {
        publicationPossible = true;
      },
    );
  } catch (error) {
    // Pre-write/read/temp/gate failures never began publication. Once rename
    // begins (or identical journal bytes were observed), an acknowledgment can
    // fail after publication, so missing journal evidence must be established.
    if (!publicationPossible) throw error;
    let absent = false;
    try {
      await readFile(journal);
    } catch (readError) {
      absent = readError.code === "ENOENT";
    }
    if (!absent) throw new ProjectCommitUncertain(project.id, error);
    throw error;
  }
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
  if (metadata.id !== expectedId || ![2, 3].includes(metadata.storageFormat))
    throw Error("项目清单格式或ID无效");
  const project = { ...metadata };
  const history = await historyManifest(directory, metadata);
  delete project.loadRuns;
  if (
    Object.hasOwn(metadata, "loadRuns") ||
    (Object.hasOwn(history, "loadReportFormat") &&
      history.loadReportFormat !== 1)
  )
    throw Error("压测报告清单格式无效");
  if (
    Object.hasOwn(metadata, "requestDefinitionHistory") ||
    (history.requestDefinitionHistoryFormat !== undefined &&
      history.requestDefinitionHistoryFormat !== 1)
  )
    throw Error("接口定义历史清单格式无效");
  if (history.requestDefinitionHistoryFormat === 1)
    project.requestDefinitionHistory = JSON.parse(
      await readFile(path.join(directory, "history/definitions.json"), "utf8"),
    );
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
    loadRuns: "history/load-reports.json",
    protocolRuns: "history/protocols.json",
    documents: "settings/documents.json",
    dictionary: "settings/dictionary.json",
    parameterDictionary: "settings/parameter-dictionary.json",
    folders: "settings/folders.json",
  })) {
    if (key === "loadRuns" && history.loadReportFormat !== 1) continue;
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
  delete project.loadReportFormat;
  delete project.storageFormat;
  delete project.collections;
  delete project.requestDefinitionHistoryFormat;
  validateRequestDefinitionHistory(project);
  validateLoadRuns(project.loadRuns === undefined ? [] : project.loadRuns);
  project._diskFingerprint = projectFingerprint(project);
  return project;
}

export function projectFingerprint(project) {
  const copy = { ...project };
  for (const key of [
    "_diskFingerprint",
    "loadReportFormat",
    "revision",
    "updatedAt",
    "history",
    "runs",
    "loadRuns",
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
