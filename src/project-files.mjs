import {
  filterStoredLiteralQueryEditor,
  validateLiteralQueryEditor,
} from "./literal-query-editor.mjs";
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
  validateLiteralQueryEditor(project);
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
const literalQueryFile = "history/literal-query-editor.json";
const retainLiteralQueryInJournal = "_retainLiteralQueryEditorFile";
const historyFields = [
  "requestDefinitionHistoryFormat",
  "loadReportFormat",
  "literalQueryEditorFormat",
];

async function requestFileIdentity(directory, requestId) {
  const info = await lstat(path.join(directory, "apis", filename(requestId)), {
    bigint: true,
  });
  if (!info.isFile()) return null;
  return createHash("sha256")
    .update(
      [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":"),
    )
    .digest("hex");
}

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

async function apply(directory, project, retainLiteralQueryFile = false) {
  const metadata = { ...project, storageFormat: 3, collections: {} };
  delete metadata._diskFingerprint;
  delete metadata.literalQueryEditor;
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
  if (retainLiteralQueryFile) localHistory.literalQueryEditorFormat = 1;
  else if (project.literalQueryEditor?.entries.length) {
    const data = project.literalQueryEditor;
    const witnesses = await Promise.all(
      data.entries.map(async ({ requestId }) => ({
        requestId,
        identity: await requestFileIdentity(directory, requestId),
      })),
    );
    if (witnesses.some(({ identity }) => !identity))
      throw Error("URL 查询编辑状态的接口文件无效");
    await writeJSON(path.join(directory, literalQueryFile), {
      data,
      witnesses,
    });
    localHistory.literalQueryEditorFormat = 1;
  } else await rm(path.join(directory, literalQueryFile), { force: true });
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
  const retainLiteralQueryFile = Object.hasOwn(
    journal,
    retainLiteralQueryInJournal,
  );
  if (
    retainLiteralQueryFile &&
    (journal[retainLiteralQueryInJournal] !== true ||
      Object.hasOwn(journal, "literalQueryEditor"))
  )
    throw Error("URL 查询编辑状态恢复日志无效");
  if (Object.hasOwn(journal, "literalQueryEditorIssue"))
    throw Error("URL 查询诊断不能写入恢复日志");
  delete journal[retainLiteralQueryInJournal];
  validateLayout(journal);
  try {
    await apply(directory, journal, retainLiteralQueryFile);
    await rm(path.join(directory, ".transaction.json"));
  } catch (error) {
    throw new ProjectCommitUncertain(expectedId, error);
  }
}
export async function writeProject(
  directory,
  project,
  { signal, beforePublish, retainLiteralQueryFile = false } = {},
) {
  const assertNotAborted = () => {
    if (signal?.aborted)
      throw Object.assign(Error("项目保存已取消"), {
        code: "STORE_SAVE_ABORTED",
      });
  };
  assertNotAborted();
  if (
    Object.hasOwn(project, retainLiteralQueryInJournal) ||
    Object.hasOwn(project, "literalQueryEditorIssue") ||
    (retainLiteralQueryFile && Object.hasOwn(project, "literalQueryEditor"))
  )
    throw Error("URL 查询编辑状态不能写入该项目事务");
  validateLayout(project);
  await mkdir(directory, { recursive: true });
  // The complete journal is written before separate files. Reads recover it under the same lock.
  // This covers process interruption, not a promise of power-loss durability.
  const journal = path.join(directory, ".transaction.json");
  let publicationPossible = false;
  try {
    await writeJSON(
      journal,
      retainLiteralQueryFile
        ? { ...project, [retainLiteralQueryInJournal]: true }
        : project,
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
    await apply(directory, project, retainLiteralQueryFile);
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
  if (
    Object.hasOwn(metadata, "literalQueryEditor") ||
    Object.hasOwn(metadata, "literalQueryEditorIssue") ||
    Object.hasOwn(metadata, retainLiteralQueryInJournal) ||
    (Object.hasOwn(history, "literalQueryEditorFormat") &&
      (metadata.storageFormat !== 3 || history.literalQueryEditorFormat !== 1))
  )
    throw Error("URL 查询编辑状态清单无效");
  if (history.literalQueryEditorFormat === 1) {
    try {
      const sidecar = path.join(directory, literalQueryFile);
      const stat = await lstat(sidecar);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
        throw Error("URL 查询编辑状态文件无效");
      const disk = JSON.parse(await readFile(sidecar, "utf8"));
      if (
        !disk ||
        Object.keys(disk).length !== 2 ||
        !Array.isArray(disk.witnesses) ||
        disk.witnesses.length > 100 ||
        !Array.isArray(disk.data?.entries) ||
        disk.witnesses.length !== disk.data.entries.length
      )
        throw Error("URL 查询编辑状态文件无效");
      const visible = new Set();
      const known = new Set(project.requests.map(({ id }) => id));
      const seen = new Set();
      for (const [index, witness] of disk.witnesses.entries()) {
        if (
          !witness ||
          Object.keys(witness).length !== 2 ||
          typeof witness.requestId !== "string" ||
          witness.requestId !== disk.data.entries[index]?.requestId ||
          seen.has(witness.requestId) ||
          typeof witness.identity !== "string" ||
          !/^[a-f0-9]{64}$/.test(witness.identity)
        )
          throw Error("URL 查询编辑状态文件身份无效");
        seen.add(witness.requestId);
        if (
          known.has(witness.requestId) &&
          witness.identity ===
            (await requestFileIdentity(directory, witness.requestId))
        )
          visible.add(witness.requestId);
      }
      const editor = filterStoredLiteralQueryEditor(
        project,
        disk.data,
        visible,
      );
      if (editor) project.literalQueryEditor = editor;
    } catch (error) {
      project.literalQueryEditorIssue =
        error?.code === "ENOENT" ? "missing" : "invalid";
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
