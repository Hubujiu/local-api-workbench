import { validateHeaderObjectRequest } from "./openapi-header-objects.mjs";
import { isDeepStrictEqual } from "node:util";
import { appendNativeInheritance } from "./native-inheritance-append.mjs";
import { isMessagePackResponseType } from "./response-media.mjs";
import {
  applyPostmanRawMedia,
  validatePostmanRawBodyRequest,
} from "./postman-raw-body.mjs";
import {
  previewManualImport,
  materializeManualImport,
  manualImportReceipt,
  manualImportError,
} from "./manual-import.mjs";
import { manualImportID } from "./manual-import-token.mjs";
import { readPlanFailurePolicy } from "./plan-failure-policy.mjs";
import {
  validateRequestDefinitionHistory,
  REQUEST_DEFINITION_HISTORY_ENVELOPE_MAX_BYTES,
  projectHistoryProjection,
  sameHistoryJSON,
  reconcileRequestDefinitionHistory,
  applyRequestDefinitionHistoryOperation,
} from "./request-definition-history.mjs";
import { isProxy } from "node:util/types";
import {
  validatePlanDefinitionTypes,
  sameStoredPlan,
} from "./plan-step-types.mjs";
import { validatePostmanOAuth2Project } from "../public/postman-oauth2-model.js";
import { applyPostmanOAuth2 } from "./postman-oauth2-token.mjs";
import {
  restoreAPIResources,
  assertAPIResourceTrashIdentity,
} from "./api-resource-restore.mjs";
import { validatePostmanCollections } from "./postman-collection-scopes.mjs";
import { linearPlanStepIds } from "./plan-step-identities.mjs";
import {
  serializeRequestPath,
  validatePathSerialization,
} from "./path-serialization.mjs";
import {
  hasRepeatSteps,
  hasRuntimeRows,
  validateRepeatGraph,
} from "./plan-repeat.mjs";
import {
  validateNativeInheritanceProject,
  assertNativeInheritanceIdentity,
  editNativeInheritance,
} from "./native-inheritance.mjs";
import { readImportedNativeFlowSource } from "./imported-native-flow-source.mjs";
import {
  normalizeImportedNativeTaskSource,
  validateRequestTaskSource,
} from "./imported-native-task-source.mjs";
import { normalizeDirectoryArtifacts } from "./apipost-directory-artifacts.mjs";
import { normalizeAutoImports } from "./active-project-import.mjs";
import {
  captureResponseHeaderEvidence,
  HTTP1_HEADER_PAIR_LIMIT,
} from "./response-header-evidence.mjs";
import { validateProjectDatabaseWriteEvidence } from "./database-write-receipts.mjs";
import { normalizeNativeTaskRequest } from "./script-database-tasks.mjs";

import { normalizeNativeMock } from "./native-mock.mjs";

import { validateGrpcSessionHistory } from "./grpc-session-evidence.mjs";
import {
  ProjectCommitUncertain,
  ProjectRecoveryRequired,
} from "./project-commit-outcome.mjs";
import {
  normalizeRedirect,
  validateRedirectAdmission,
  validatePreparedRedirectHeaders,
} from "./http-redirect.mjs";
import { executePreparedRedirect } from "./http-redirect-transport.mjs";
import { validateQueryArrayRequest } from "./openapi-query-arrays.mjs";
import { multipartPartMedia } from "./multipart-part-media.mjs";
import { applyNativeOAuth2 } from "./native-oauth2-token.mjs";
import { normalizeGrpcDefinitions } from "./grpc.mjs";
import {
  activeAPIFolders,
  apiResourceTargets,
  validateAPIResourceTrash,
  validateResourceJSON,
} from "./api-resource-lifecycle.mjs";
import { validateProtocolRuns } from "./protocol-evidence.mjs";
import { normalizeSocketIODefinitions } from "./socketio.mjs";
import { validateCaseFolders } from "../public/case-folders.js";
import { requestCookieHeader } from "./request-cookies.mjs";
import {
  appendRequestQuery,
  setURLQuery,
  setAPIKeyQuery,
} from "./query-serialization.mjs";
import { requestHeaderMap } from "./request-headers.mjs";
import { asapAuthorization } from "./asap-auth.mjs";
import { jwtAuthorization } from "./jwt-auth.mjs";
import { validateModelFolders } from "../public/model-folders.js";
import { validateSharedScriptSettings } from "./shared-scripts.mjs";
import { validateSharedAuthSettings } from "./shared-auth.mjs";
import {
  validateGlobalParameters,
  validateFolderParameters,
} from "./global-parameters.mjs";
import { ntlmType1, parseNtlmChallenge, ntlmType3 } from "./ntlm.mjs";
import { edgegridAuthorization } from "./edgegrid-auth.mjs";
import { hawkAuthorization } from "./hawk-auth.mjs";
import { awsSignatureRequest, validateAWSQueryURL } from "./aws-signature.mjs";
import { validateAuth } from "../public/auth-model.js";
import { oauth1Request, oauth1ParameterPolicy } from "./oauth1.mjs";
import { validateAttributeValues } from "../public/attribute-model.js";
import { validateMockFieldSettings } from "./mock-fields.mjs";
import { normalizeParameterEntry } from "./parameter-dictionary.mjs";
import { normalizeProtocol } from "./protocol-definitions.mjs";
import { existsSync } from "node:fs";
import {
  readProject,
  writeProject,
  projectFingerprint,
} from "./project-files.mjs";
import { validateMockRules } from "./mock.mjs";
import { validateResources } from "./resources.mjs";
import { snapshotCase } from "./cases.mjs";
import { validateEnvironmentModel } from "./environments.mjs";
import { acquireFileLock } from "./file-lock.mjs";
import {
  throwIfInactive,
  interruptionKind,
  requestTimeout,
} from "./request-control.mjs";
import {
  httpFinalizationFailure,
  readHttpFinalizationFailure,
} from "./http-finalization.mjs";
import { prepareConnection } from "./connection.mjs";
import { digestAuthorization, digestChallengePolicy } from "./digest.mjs";
import { responseContentDecoder } from "./http-response-content.mjs";
import { performance } from "node:perf_hooks";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import {
  id,
  normalizeRequest,
  normalizeHistoricalRequest,
  snapshotPlan,
  restoreProject,
} from "./core.mjs";
// Parsed disk records are inspected without normalizing historical definitions.
// Only runtime-row graphs opt into the new strict snapshot contract; legacy
// opaque plans retain their existing inert read behavior.
function validateStoredRuntimeRows(project) {
  const contains = (steps) =>
    Array.isArray(steps) &&
    steps.some(
      (step) =>
        step &&
        ["repeat", "if"].includes(step.type) &&
        ((step.type === "repeat" && Object.hasOwn(step, "rowsFrom")) ||
          contains(step.steps)),
    );
  for (const plan of [
    ...(project.plans || []),
    ...(project.runs || []).map((run) => run?.snapshot).filter(Boolean),
  ]) {
    if (contains(plan?.steps)) {
      validateRepeatGraph(plan.steps, {
        requireIds: true,
        allowRuntimeRows: true,
      });
      snapshotPlan(plan, { allowRuntimeRows: hasRepeatSteps(plan.steps) });
    }
  }
}

export class Store {
  constructor(root) {
    this.root = root;
    this.pending = Promise.resolve();
    this.locations = {};
    this.pendingLocations = {};
    this.creationErrors = {};
  }
  async init() {
    await mkdir(this.root, { recursive: true });
    const release = await acquireFileLock(
      path.join(this.root, ".registry.lock"),
    );
    let primaryError;
    try {
      await this.#loadRegistry();
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await release();
      } catch (error) {
        throw primaryError || error;
      }
    }
  }
  async #readRegistryFile(name) {
    try {
      let value = JSON.parse(
        await readFile(path.join(this.root, name), "utf8"),
      );
      if (name === ".creations.json") {
        if (
          value?.version !== 1 ||
          Object.keys(value).sort().join(",") !== "projects,version"
        )
          throw Error("项目创建登记格式无效");
        value = value.projects;
      }
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([key, base]) =>
            !/^[a-zA-Z0-9-]+$/.test(key) ||
            typeof base !== "string" ||
            !path.isAbsolute(base),
        )
      )
        throw Error("项目位置登记格式无效");
      return value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return {};
    }
  }
  async #writeRegistryFile(name, value) {
    const temporary = path.join(this.root, name + "." + id() + ".tmp");
    try {
      await writeFile(
        temporary,
        JSON.stringify(
          name === ".creations.json" ? { version: 1, projects: value } : value,
          null,
          2,
        ),
        {
          mode: 0o600,
          flag: "wx",
        },
      );
      await rename(temporary, path.join(this.root, name));
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  // Called only under the registry lock. Creation intents are not projects: an
  // interrupted pre-journal attempt can retire only its registration, never data.
  async #loadRegistry() {
    this.locations = await this.#readRegistryFile(".locations.json");
    const pending = await this.#readRegistryFile(".creations.json");
    this.pendingLocations = {};
    this.creationErrors = {};
    for (const [key, base] of Object.entries(pending)) {
      if (Object.hasOwn(this.locations, key) && this.locations[key] !== base)
        throw Error("项目创建登记位置冲突");
      let release, primaryError;
      try {
        release = await acquireFileLock(path.join(base, key + ".json.lock"));
        const recoverable =
          (await this.#pathExists(path.join(base, key, "project.json"))) ||
          (await this.#pathExists(path.join(base, key, ".transaction.json"))) ||
          (await this.#pathExists(path.join(base, key + ".json")));
        // A published registration is evidence of a recoverable commit, even
        // if files were later moved or made unavailable. Never erase it here.
        if (recoverable && base !== path.resolve(this.root))
          this.locations[key] = base;
        await this.#writeRegistryFile(".locations.json", this.locations);
        delete pending[key];
        await this.#writeRegistryFile(".creations.json", pending);
      } catch (error) {
        primaryError = error;
      } finally {
        try {
          await release?.();
        } catch (error) {
          primaryError ||= error;
        }
      }
      if (primaryError) {
        // An unavailable custom disk or unknown project lock must not prevent
        // startup/access to healthy projects. Keep the intent and report this ID
        // as unresolved; the create guard still fails closed.
        this.pendingLocations[key] = base;
        this.creationErrors[key] = new ProjectRecoveryRequired([key]);
      }
    }
  }
  async #pathExists(file) {
    try {
      await lstat(file);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  base(key) {
    if (!/^[a-zA-Z0-9-]+$/.test(key)) throw Error("无效项目 ID");
    return this.locations[key] || this.pendingLocations[key] || this.root;
  }
  directory(key) {
    return path.join(this.base(key), key);
  }
  legacyFile(key) {
    return path.join(this.base(key), key + ".json");
  }
  lockFile(key) {
    return this.legacyFile(key) + ".lock";
  }
  file(key) {
    const metadata = path.join(this.directory(key), "project.json");
    return existsSync(metadata) ? metadata : this.legacyFile(key);
  }
  async list() {
    await this.init();
    return this.#listRegistered();
  }
  async #listRegistered() {
    const entries = await readdir(this.root, { withFileTypes: true });
    const keys = new Set([
      ...entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".json") &&
            !entry.name.startsWith("."),
        )
        .map((entry) => entry.name.slice(0, -5)),
      ...entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            /^[a-zA-Z0-9-]+$/.test(entry.name) &&
            (existsSync(path.join(this.root, entry.name, "project.json")) ||
              existsSync(
                path.join(this.root, entry.name, ".transaction.json"),
              )),
        )
        .map((entry) => entry.name),
      ...Object.keys(this.locations),
      ...Object.keys(this.pendingLocations),
    ]);
    const out = [];
    for (const key of keys) {
      try {
        const p = await this.#getRegistered(key);
        out.push({
          id: p.id,
          name: p.name,
          updatedAt: p.updatedAt,
          archived: !!p.archived,
        });
      } catch (error) {
        out.push({
          id: key,
          name: key + "（文件无法读取）",
          error: error.message,
        });
      }
    }
    return out;
  }
  async readUnlocked(key, base = this.base(key)) {
    const directory = path.join(base, key);
    if (await this.#pathExists(directory)) {
      const entries = await readdir(directory, { withFileTypes: true });
      // A failed legacy migration can leave only its unpublished journal temp
      // (or an empty directory). Only that precommit layout may use the legacy
      // source again. Split resources with a missing manifest are not a backup.
      if (
        entries.some(
          (entry) =>
            !entry.isFile() ||
            !/^\.transaction\.json\.[a-f0-9-]{36}\.tmp$/i.test(entry.name),
        )
      ) {
        const project = await readProject(directory, key);
        validateStoredRuntimeRows(project);
        validateNativeInheritanceProject(project);
        validateAPIResourceTrash(project);
        validatePostmanOAuth2Project(project);
        validateGrpcSessionHistory(project.protocolRuns ?? []);
        validateRequestDefinitionHistory(project);
        return project;
      }
    }
    const project = JSON.parse(
      await readFile(path.join(base, key + ".json"), "utf8"),
    );
    validateStoredRuntimeRows(project);
    validateNativeInheritanceProject(project);
    validateAPIResourceTrash(project);
    validatePostmanOAuth2Project(project);
    validateGrpcSessionHistory(project.protocolRuns ?? []);
    validateRequestDefinitionHistory(project);
    project._diskFingerprint = projectFingerprint(project);
    return project;
  }
  async get(key) {
    await this.init();
    return this.#getRegistered(key);
  }
  async #getRegistered(key) {
    const base = this.base(key);
    if (Object.hasOwn(this.creationErrors, key)) throw this.creationErrors[key];
    const release = await acquireFileLock(path.join(base, key + ".json.lock"));
    let primaryError;
    try {
      return await this.readUnlocked(key, base);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await release();
      } catch (error) {
        throw primaryError || error;
      }
    }
  }
  async create(name, directory, { description } = {}) {
    if (directory && !path.isAbsolute(directory))
      throw Error("存储位置必须是绝对路径");
    const p = {
      version: 1,
      id: id(),
      name: String(name || "新项目").slice(0, 100),
      ...(description === undefined ? {} : { description }),
      requests: [],
      environments: [
        {
          id: id(),
          name: "默认环境",
          variables: { baseUrl: "http://127.0.0.1:4318" },
        },
      ],
      plans: [],
      cases: [],
      protocols: [],
      runs: [],
      protocolRuns: [],
      history: [],
      dictionary: [],
      parameterDictionary: [],
      documents: [],
      settings: {},
    };
    return this.#queueCreation(p, directory);
  }
  async restore(document) {
    const p = restoreProject(document);
    // A backup is an explicitly requested new identity, never an update/upsert.
    // The exclusive creation path assigns its own first revision and fingerprint.
    delete p.configRevision;
    delete p._diskFingerprint;
    return this.#queueCreation(p, undefined, true);
  }
  #queueCreation(p, directory, restoring = false) {
    this.#validateProject(p);
    validateRequestDefinitionHistory(p);
    const task = this.pending
      .catch(() => {})
      .then(() => this.#createProject(p, directory, restoring));
    this.pending = task;
    return task;
  }
  async #createProject(p, directory, restoring = false) {
    await mkdir(this.root, { recursive: true });
    const releaseRegistry = await acquireFileLock(
      path.join(this.root, ".registry.lock"),
    );
    let committed = false,
      primaryError;
    try {
      await this.#loadRegistry();
      // A backup must remain usable to create a separate healthy copy while an
      // unrelated/source project is damaged. Ordinary create keeps its guard.
      if (!restoring) {
        const unresolved = (await this.#listRegistered()).filter(
          (project) => project.error,
        );
        if (unresolved.length)
          throw new ProjectRecoveryRequired(
            unresolved.map((project) => project.id),
          );
      }
      const pending = { ...this.pendingLocations };
      const base = path.resolve(directory || this.root),
        target = path.join(base, p.id);
      await mkdir(base, { recursive: true });
      if (
        Object.hasOwn(this.locations, p.id) ||
        Object.hasOwn(pending, p.id) ||
        (await this.#pathExists(path.join(this.root, p.id))) ||
        (await this.#pathExists(path.join(this.root, p.id + ".json")))
      )
        throw Error("项目ID或存储目录已存在");
      const release = await acquireFileLock(
        path.join(base, p.id + ".json.lock"),
      );
      let writeError,
        intent = false;
      try {
        if (
          (await this.#pathExists(target)) ||
          (await this.#pathExists(path.join(base, p.id + ".json")))
        )
          throw Error("项目ID或存储目录已存在");
        // Exclusive reservation: never initialize inside a pre-existing user directory.
        await mkdir(target);
        await this.#writeRegistryFile(".creations.json", {
          ...pending,
          [p.id]: base,
        });
        intent = true;
        try {
          await this.#saveLocked(p, {}, base, true);
          committed = true;
        } catch (error) {
          if (error instanceof ProjectCommitUncertain) committed = true;
          throw error;
        }
      } catch (error) {
        writeError = error;
      }
      try {
        if (intent) {
          if (!committed && writeError) {
            // Never retire an intent if actual disk evidence is ambiguous. The
            // ordinary pre-journal error remains definite only with proven absence.
            try {
              committed =
                (await this.#pathExists(path.join(target, "project.json"))) ||
                (await this.#pathExists(
                  path.join(target, ".transaction.json"),
                )) ||
                (await this.#pathExists(path.join(base, p.id + ".json")));
            } catch (error) {
              throw new ProjectCommitUncertain(p.id, error);
            }
            if (committed && !(writeError instanceof ProjectCommitUncertain))
              writeError = new ProjectCommitUncertain(p.id, writeError);
          }
          if (committed && base !== path.resolve(this.root)) {
            this.locations[p.id] = base;
            await this.#writeRegistryFile(".locations.json", this.locations);
          }
          await this.#writeRegistryFile(".creations.json", pending);
        }
      } catch (error) {
        // A committed project remains discoverable through its durable intent.
        writeError =
          error instanceof ProjectCommitUncertain
            ? error
            : writeError ||
              (committed ? new ProjectCommitUncertain(p.id, error) : error);
      } finally {
        try {
          await release();
        } catch (error) {
          writeError =
            writeError ||
            (committed ? new ProjectCommitUncertain(p.id, error) : error);
        }
      }
      if (writeError) throw writeError;
      return p;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await releaseRegistry();
      } catch (error) {
        throw (
          primaryError ||
          (committed ? new ProjectCommitUncertain(p.id, error) : error)
        );
      }
    }
  }
  async editNativeInheritance(projectId, input, { nativeTrash = false } = {}) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) => !["configRevision", "operation"].includes(k),
      ) ||
      !Number.isSafeInteger(input.configRevision) ||
      input.configRevision < 0
    )
      throw Error("继承图操作必须提供有效configRevision和operation");
    const current = await this.get(projectId);
    if (input.configRevision !== current.configRevision)
      throw Error("项目已有其他修改，请重新加载");
    const context = ["recycle-requests", "recycle-folder"].includes(
      input.operation?.type,
    )
      ? {
          deletedAt: new Date().toISOString(),
          ...(nativeTrash || input.operation.type === "recycle-folder"
            ? { nativeTrash: true, batchId: id() }
            : {}),
        }
      : {};
    const next = editNativeInheritance(current, input.operation, context);
    const operation = structuredClone(input.operation);
    return this.save(next, {
      nativeInheritanceEdit: operation,
      nativeInheritanceEditContext: context,
    });
  }
  async restoreAPIResources(projectId, input) {
    validateResourceJSON(input, 4096);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !["configRevision", "batchId"].includes(key),
      ) ||
      !Number.isSafeInteger(input.configRevision) ||
      input.configRevision < 0 ||
      typeof input.batchId !== "string" ||
      !input.batchId.trim() ||
      input.batchId.length > 200
    )
      throw Error("资源恢复须提供有效configRevision和batchId");
    const current = await this.get(projectId);
    if (
      input.configRevision !== (current.configRevision ?? current.revision ?? 0)
    )
      throw Error("项目已有其他修改，请重新加载");
    const apiResourceRestore = {
      batchId: input.batchId,
      restoredAt: new Date().toISOString(),
    };
    const next = restoreAPIResources(
      current,
      input.batchId,
      apiResourceRestore,
    ).project;
    return this.save(next, { apiResourceRestore });
  }
  async changeRequestDefinitionHistory(projectId, input, { signal } = {}) {
    const value = projectHistoryProjection(input, { maxBytes: 32768 });
    if (
      !value ||
      !Number.isSafeInteger(value.configRevision) ||
      value.configRevision < 0
    )
      throw Error("定义历史操作须提供有效configRevision");
    const { configRevision, ...definitionHistoryOperation } = value;
    const current = await this.get(projectId);
    if (configRevision !== (current.configRevision ?? current.revision ?? 0))
      throw Error("项目已有其他修改，请重新加载");
    return this.save(current, { signal, definitionHistoryOperation });
  }
  async previewManualImport(projectId, input, { sessionId, signal } = {}) {
    try {
      signal?.throwIfAborted();
      const current = await this.get(projectId);
      return await previewManualImport(current, input, {
        sessionId,
        signal,
        validate: (candidate, context) => {
          this.#validateProject(candidate);
          const simulated = structuredClone(candidate);
          simulated.revision = (current.revision || 0) + 1;
          simulated.configRevision =
            (current.configRevision ?? current.revision ?? 0) + 1;
          simulated.updatedAt = new Date(context.issuedAt).toISOString();
          let index = 0;
          const history = reconcileRequestDefinitionHistory(
            current,
            simulated,
            {
              now: simulated.updatedAt,
              makeId: () =>
                manualImportID(context, `history-simulation:${index++}`),
            },
          );
          const before = current.requestDefinitionHistory?.entries || [];
          const after = history?.entries || [];
          const oldVersions = new Set(
            before.flatMap((entry) => entry.versions.map((v) => v.id)),
          );
          const newVersions = new Set(
            after.flatMap((entry) => entry.versions.map((v) => v.id)),
          );
          const oldLineages = new Set(before.map((entry) => entry.lineageId));
          if (
            current.settings?.nativeInheritance &&
            [...oldVersions].some((id) => !newVersions.has(id))
          )
            throw Error("原生追加不能裁剪已有历史");
          return {
            createdLineages: after.filter(
              (entry) => !oldLineages.has(entry.lineageId),
            ).length,
            addedSnapshots: [...newVersions].filter(
              (id) => !oldVersions.has(id),
            ).length,
            prunedSnapshots: [...oldVersions].filter(
              (id) => !newVersions.has(id),
            ).length,
          };
        },
      });
    } catch (error) {
      throw manualImportError(error);
    }
  }
  async applyManualImport(projectId, input, { sessionId, signal } = {}) {
    // No detached preview candidate is accepted. The normal Store pending chain
    // and SQLite project lock protect recovery, CAS, planning and publication.
    const task = this.pending
      .catch(() => {})
      .then(async () => {
        signal?.throwIfAborted();
        await this.init();
        const base = this.base(projectId);
        if (Object.hasOwn(this.creationErrors, projectId))
          throw this.creationErrors[projectId];
        const release = await acquireFileLock(
          path.join(base, projectId + ".json.lock"),
          { signal },
        );
        let committed = false,
          primaryError;
        try {
          signal?.throwIfAborted();
          const current = await this.readUnlocked(projectId, base);
          const result = await materializeManualImport(current, input, {
            sessionId,
            signal,
          });
          if (result.noOp) {
            result.beforePublish();
            return manualImportReceipt(current, result);
          }
          this.#validateProject(result.project);
          await this.#saveLocked(
            result.project,
            {
              signal,
              beforePublish: result.beforePublish,
              nativeAppend: result.nativeAppend,
            },
            base,
          );
          committed = true;
          return manualImportReceipt(result.project, result);
        } catch (error) {
          primaryError = error;
          throw error;
        } finally {
          try {
            await release();
          } catch (error) {
            throw (
              primaryError ||
              (committed ? new ProjectCommitUncertain(projectId, error) : error)
            );
          }
        }
      })
      .catch((error) => {
        throw manualImportError(error);
      });
    this.pending = task;
    return task;
  }
  #validateProject(p) {
    // History is opaque service-owned evidence, not user-supplied executable
    // objects. Inspect its descriptor before any clone/JSON operation.
    if (isProxy(p)) throw Error("项目不能为代理对象");
    const historyDescriptor = Object.getOwnPropertyDescriptor(
      p,
      "requestDefinitionHistory",
    );
    if (historyDescriptor) {
      if (
        !Object.hasOwn(historyDescriptor, "value") ||
        !historyDescriptor.enumerable
      )
        throw Error("接口定义历史不能包含访问器");
      projectHistoryProjection(historyDescriptor.value, {
        maxBytes: REQUEST_DEFINITION_HISTORY_ENVELOPE_MAX_BYTES,
      });
    }
    if (
      !Array.isArray(p.plans) ||
      isProxy(p.plans) ||
      p.plans.length > 1000 ||
      Object.getPrototypeOf(p.plans) !== Array.prototype ||
      Reflect.ownKeys(p.plans).length !== p.plans.length + 1
    )
      throw Error("计划最多1000个普通数据项");
    for (let index = 0; index < p.plans.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(p.plans, String(index));
      if (!entry?.enumerable || !Object.hasOwn(entry, "value"))
        throw Error("计划不能包含访问器或空洞");
    }
    // Unknown legacy discriminators remain inert until lock-held disk comparison.
    // Never defer accessor, Proxy or cyclic input to later normalizers.
    for (const plan of p.plans) {
      readPlanFailurePolicy(plan);
      try {
        validatePlanDefinitionTypes(plan);
      } catch (error) {
        if (
          error.code !== "PLAN_STEP_TYPE_INVALID" ||
          !sameStoredPlan(plan, plan, 100000)
        )
          throw error;
      }
    }

    for (const plan of p.plans)
      if (hasRepeatSteps(plan.steps) && hasRuntimeRows(plan.steps))
        snapshotPlan(plan, { allowRuntimeRows: hasRepeatSteps(plan.steps) });
    validatePostmanOAuth2Project(p);
    validatePostmanCollections(p);
    // Preflight the whole definition batch before normalizing any collection.
    if (!Array.isArray(p.plans) || p.plans.length > 1000)
      throw Error("计划最多1000个");
    for (const plan of p.plans)
      if (!hasRepeatSteps(plan.steps)) linearPlanStepIds(plan.steps);
    for (const request of p.requests || []) validatePathSerialization(request);
    validateNativeInheritanceProject(p);

    validateAPIResourceTrash(p);
    if (p.settings?.autoImports !== undefined)
      p.settings.autoImports = normalizeAutoImports(p.settings.autoImports);
    for (const request of p.requests || []) normalizeRedirect(request.redirect);
    for (const request of p.requests || []) validateQueryArrayRequest(request);
    for (const request of p.requests || [])
      validateHeaderObjectRequest(request);
    validateProjectDatabaseWriteEvidence(p);
    validateEnvironmentModel(p);
    validateModelFolders(p);
    validateCaseFolders(p);
    if (p.protocols !== undefined) {
      if (!Array.isArray(p.protocols) || p.protocols.length > 1000)
        throw Error("协议定义最多1000个");
      p.protocols = p.protocols.map(normalizeProtocol);
    }
    p.documents = (p.documents || []).map((document) => ({
      ...document,
      id: document.id || id(),
    }));
    if (!Array.isArray(p.plans) || p.plans.length > 1000)
      throw Error("计划最多1000个");
    for (const run of p.runs || [])
      if (run.snapshot) {
        readPlanFailurePolicy(run.snapshot);
        readImportedNativeFlowSource(run.snapshot);
        if (hasRepeatSteps(run.snapshot.steps)) {
          if (hasRuntimeRows(run.snapshot.steps))
            validateRepeatGraph(run.snapshot.steps, {
              requireIds: true,
              allowRuntimeRows: true,
            });
          snapshotPlan(run.snapshot, { allowRuntimeRows: true });
        }
      }
    if (p.settings?.grpcDefinitions !== undefined)
      p.settings.grpcDefinitions = normalizeGrpcDefinitions(
        p.settings.grpcDefinitions,
      );
    if (p.settings?.socketioDefinitions !== undefined)
      p.settings.socketioDefinitions = normalizeSocketIODefinitions(
        p.settings.socketioDefinitions,
      );
    validateProtocolRuns(p.protocolRuns ?? []);
    if (p.settings?.apipostDirectoryArtifacts !== undefined)
      p.settings.apipostDirectoryArtifacts = normalizeDirectoryArtifacts(
        p.settings.apipostDirectoryArtifacts,
      );
    validateResources(p.settings || {});
    validateSharedAuthSettings(p.settings);
    validateSharedScriptSettings(p.settings);
    validateGlobalParameters(p.settings?.globalParameters);
    validateFolderParameters(p.settings?.folderParameters);
    for (const record of [...(p.requests || []), ...p.documents]) {
      validateAttributeValues(record.attributes, p.settings?.attributes || []);
      if (
        record.statusId !== undefined &&
        (typeof record.statusId !== "string" || record.statusId.length > 200)
      )
        throw Error("状态标识无效");
    }
    const fieldRules = validateMockFieldSettings(p.settings || {});
    if (p.settings?.mockFieldRules !== undefined)
      p.settings.mockFieldRules = fieldRules;
    if (p.parameterDictionary !== undefined) {
      if (
        !Array.isArray(p.parameterDictionary) ||
        p.parameterDictionary.length > 5000
      )
        throw Error("参数字典最多5000条");
      p.parameterDictionary = p.parameterDictionary.map(
        normalizeParameterEntry,
      );
    }
    for (const request of p.requests || []) {
      validateRequestTaskSource(request);
      validateAuth(request.auth);
      validateMockRules(request.mockRules || []);
      if (request.nativeTasks !== undefined)
        request.nativeTasks = normalizeNativeTaskRequest(request);
      if (request.nativeMock !== undefined) {
        if (request.mockRules?.length)
          throw Error("原版Mock与普通Mock规则不能混用");
        request.nativeMock = normalizeNativeMock(request.nativeMock);
      }
      if (request.importedNativeTaskSource !== undefined)
        request.importedNativeTaskSource = normalizeImportedNativeTaskSource(
          request.importedNativeTaskSource,
        );
    }
    if (p.cases !== undefined) {
      if (!Array.isArray(p.cases) || p.cases.length > 1000)
        throw Error("用例最多1000个");
      p.cases = p.cases.map(snapshotCase);
      if (new Set(p.cases.map((item) => item.id)).size !== p.cases.length)
        throw Error("用例ID重复");
    }
  }
  async save(
    p,
    {
      activity = false,
      signal,
      nativeInheritanceEdit,
      nativeInheritanceEditContext,
      apiResourceRestore,
      definitionHistoryOperation,
    } = {},
  ) {
    if (apiResourceRestore !== undefined && activity)
      throw Error("资源恢复不能伪装为活动记录更新");
    if (definitionHistoryOperation !== undefined && activity)
      throw Error("定义历史操作不能伪装为活动记录更新");
    if (definitionHistoryOperation !== undefined)
      definitionHistoryOperation = projectHistoryProjection(
        definitionHistoryOperation,
        {
          maxBytes: 32768,
        },
      );
    if (signal?.aborted)
      throw Object.assign(Error("项目保存已取消"), {
        code: "STORE_SAVE_ABORTED",
      });
    this.#validateProject(p);
    const task = this.pending
      .catch(() => {})
      .then(async () => {
        await this.init();
        const base = this.base(p.id);
        if (Object.hasOwn(this.creationErrors, p.id))
          throw this.creationErrors[p.id];
        const release = await acquireFileLock(
          path.join(base, p.id + ".json.lock"),
        );
        let committed = false,
          primaryError;
        try {
          await this.#saveLocked(
            p,
            {
              activity,
              signal,
              nativeInheritanceEdit,
              nativeInheritanceEditContext,
              apiResourceRestore,
              definitionHistoryOperation,
            },
            base,
          );
          committed = true;
          return p;
        } catch (error) {
          primaryError = error;
          throw error;
        } finally {
          try {
            await release();
          } catch (error) {
            throw (
              primaryError ||
              (committed ? new ProjectCommitUncertain(p.id, error) : error)
            );
          }
        }
      });
    this.pending = task;
    return task;
  }
  async #saveLocked(
    p,
    {
      activity = false,
      signal,
      beforePublish,
      nativeAppend,
      nativeInheritanceEdit,
      nativeInheritanceEditContext,
      apiResourceRestore,
      definitionHistoryOperation,
    },
    base,
    creating = false,
  ) {
    let previous;
    try {
      previous = await this.readUnlocked(p.id, base);
    } catch (error) {
      // Only #createProject owns an exclusively reserved new directory. A
      // missing child, manifest, or whole project is never an update-as-create.
      // Even creation cannot reinterpret existing commit evidence as absence.
      if (
        !creating ||
        error.code !== "ENOENT" ||
        (await this.#pathExists(path.join(base, p.id, "project.json"))) ||
        (await this.#pathExists(path.join(base, p.id, ".transaction.json"))) ||
        (await this.#pathExists(path.join(base, p.id + ".json")))
      )
        throw error;
    }
    if (creating && previous) throw Error("项目ID或存储目录已存在");
    if (
      previous &&
      p._diskFingerprint &&
      p._diskFingerprint !== previous._diskFingerprint
    )
      throw Error("项目文件已被其他窗口或 Git 修改，请重新加载后再保存");
    const previousConfiguration =
      previous?.configRevision ?? previous?.revision ?? 0;
    const expectedConfiguration = p.configRevision ?? p.revision ?? 0;
    if (
      previous &&
      (activity
        ? (p.revision || 0) !== (previous.revision || 0)
        : expectedConfiguration !== previousConfiguration)
    )
      throw Error("项目已被其他窗口或 MCP 修改，请重新加载后再保存");
    if (activity && previous && !sameStoredPlan(p.plans, previous.plans))
      throw Error("活动记录保存不能修改计划定义或步骤类型");
    if (
      previous &&
      Object.hasOwn(p, "requestDefinitionHistory") &&
      !sameHistoryJSON(
        p.requestDefinitionHistory,
        previous.requestDefinitionHistory,
        { maxBytes: REQUEST_DEFINITION_HISTORY_ENVELOPE_MAX_BYTES },
      )
    )
      throw Error("接口定义历史由服务端维护，不能随项目保存修改");
    if (previous) {
      if (previous.requestDefinitionHistory === undefined)
        delete p.requestDefinitionHistory;
      else
        p.requestDefinitionHistory = structuredClone(
          previous.requestDefinitionHistory,
        );
    }
    if (
      activity &&
      previous &&
      !sameHistoryJSON(p.requests, previous.requests, {
        maxBytes: Number.MAX_SAFE_INTEGER,
      })
    )
      throw Error("活动记录保存不能修改接口定义");
    if (definitionHistoryOperation !== undefined) {
      if (!previous || projectFingerprint(p) !== projectFingerprint(previous))
        throw Error("定义历史操作不能同时修改其他项目配置");
      if (previous.archived) throw Error("归档项目不可修改定义历史");
      apiResourceTargets(previous);
      const changed = applyRequestDefinitionHistoryOperation(
        previous,
        definitionHistoryOperation,
      );
      if (definitionHistoryOperation.kind === "restore") {
        const index = changed.requests.findIndex(
          (request) => request.id === definitionHistoryOperation.requestId,
        );
        const selected = changed.requests[index];
        const normalized = normalizeHistoricalRequest(selected);
        if (
          normalized.folder &&
          !activeAPIFolders(previous).includes(normalized.folder)
        )
          throw Error("历史定义的目录已不存在；请先恢复目录");
        changed.requests[index] = normalized;
      }
      this.#validateProject(changed);
      Object.assign(p, changed);
    }
    // Only exact existing disk definitions may remain inert. Never use
    // activity:true or a matching ID as authority to admit edited types.
    const opaquePlans = new Set();
    const retainedPlans = new Set();
    for (const plan of p.plans) {
      try {
        validatePlanDefinitionTypes(plan);
      } catch (error) {
        const old = previous?.plans?.find(
          (item) => !retainedPlans.has(item) && sameStoredPlan(plan, item),
        );
        if (
          error.code !== "PLAN_STEP_TYPE_INVALID" ||
          !old ||
          retainedPlans.has(old)
        )
          throw error;
        retainedPlans.add(old);
        opaquePlans.add(plan);
      }
    }
    const unnormalizedPlans = p.plans;
    const normalizedPlans = p.plans.map((plan) =>
      opaquePlans.has(plan)
        ? structuredClone(plan)
        : snapshotPlan(plan, { allowRuntimeRows: hasRepeatSteps(plan.steps) }),
    );
    p.plans =
      activity && previous ? structuredClone(previous.plans) : normalizedPlans;
    // Preserve graph identity after applying the same snapshot normalization to
    // both disk and candidate shapes, including frozen cases/plans/history.
    const identityPrevious =
      nativeInheritanceEdit && previous
        ? {
            ...previous,
            plans: previous.plans.map((plan) =>
              retainedPlans.has(plan)
                ? structuredClone(plan)
                : snapshotPlan(plan, {
                    allowRuntimeRows: hasRepeatSteps(plan.steps),
                  }),
            ),
            cases: previous.cases?.map(snapshotCase),
          }
        : previous;
    if (nativeAppend) {
      const expected = appendNativeInheritance(
        previous,
        nativeAppend.source,
        nativeAppend.context,
      ).project;
      this.#validateProject(expected);
      // Append must retain the complete locked plan collection before ordinary
      // Store normalization. Prove that independently, then reuse its one
      // validated normalization: a second snapshot rejects retained opaque
      // plans and allocates different IDs/timestamps for sparse legacy plans.
      if (!sameStoredPlan(expected.plans, unnormalizedPlans))
        throw Error("原生追加不能夹带计划修改");
      expected.plans = structuredClone(p.plans);
      // The sole private import path must match the entire replayed project,
      // not merely graph identity or a caller-controlled append flag.
      if (!isDeepStrictEqual(expected, p))
        throw Error("原生追加不能夹带其他修改");
    }
    assertNativeInheritanceIdentity(
      nativeAppend ? p : identityPrevious,
      p,
      nativeInheritanceEdit,
      nativeInheritanceEditContext,
    );
    // Preserve the existing stale-activity retry gate before checking history.
    const resourcePrevious =
      apiResourceRestore && previous
        ? {
            ...previous,
            plans: previous.plans.map((plan) =>
              retainedPlans.has(plan)
                ? structuredClone(plan)
                : snapshotPlan(plan, {
                    allowRuntimeRows: hasRepeatSteps(plan.steps),
                  }),
            ),
            cases: previous.cases?.map(snapshotCase),
          }
        : previous;
    assertAPIResourceTrashIdentity(resourcePrevious, p, apiResourceRestore);
    const next = structuredClone(p);
    next.revision = (previous?.revision || 0) + 1;
    next.configRevision = activity
      ? previousConfiguration
      : previousConfiguration + 1;
    if (!activity && previous) {
      next.history = previous.history;
      next.runs = previous.runs;
      next.protocolRuns = previous.protocolRuns || [];
    }
    next.updatedAt = new Date().toISOString();
    const definitions = reconcileRequestDefinitionHistory(previous, next, {
      activity,
      now: next.updatedAt,
      restoredRequestId:
        definitionHistoryOperation?.kind === "restore"
          ? definitionHistoryOperation.requestId
          : undefined,
    });
    if (nativeAppend) {
      for (const entry of previous.requestDefinitionHistory?.entries || [])
        if (
          !isDeepStrictEqual(
            entry,
            definitions?.entries.find(
              (item) => item.requestId === entry.requestId,
            ),
          )
        )
          throw Error("原生追加不能修改已有定义历史");
    }
    if (definitions === undefined) delete next.requestDefinitionHistory;
    else next.requestDefinitionHistory = definitions;
    validateRequestDefinitionHistory(next);
    if (signal?.aborted)
      throw Object.assign(Error("项目保存已取消"), {
        code: "STORE_SAVE_ABORTED",
      });
    await writeProject(path.join(base, p.id), next, { signal, beforePublish });
    try {
      const saved = await readProject(path.join(base, p.id), p.id);
      validateAPIResourceTrash(saved);
      Object.assign(p, saved);
    } catch (error) {
      throw new ProjectCommitUncertain(p.id, error);
    }
    return p;
  }
  async append(key, field, value, limit = 50) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const p = await this.get(key);
      p[field] = [value, ...(p[field] || [])].slice(0, limit);
      try {
        return await this.save(p, { activity: true });
      } catch (e) {
        if (!e.message.includes("其他窗口") || attempt === 4) throw e;
      }
    }
  }
}
export async function executeRequest(input, signal, { cookieSession } = {}) {
  if (input?.nativeInheritance !== undefined)
    throw Error("请求须先按当前项目解析原生继承图");

  const r = normalizeRequest(input);
  return executeRequestWithinDeadline(
    r,
    signal,
    cookieSession,
    performance.now() + r.timeout,
  );
}

// Private: authentication replay cannot accept or reset a caller-supplied budget.
async function executeRequestWithinDeadline(
  r,
  signal,
  cookieSession,
  deadline,
  replay,
) {
  const controls = { signal, deadline };
  throwIfInactive(controls);
  validatePostmanRawBodyRequest(r);
  // Detach the admitted policy before any connection/cookie await.
  const digestPolicy =
    r.auth.type === "digest" ? digestChallengePolicy(r.auth) : undefined;
  if (digestPolicy) r.auth.challengePolicy = digestPolicy;
  const oauthPolicy =
    r.auth.type === "oauth1" ? oauth1ParameterPolicy(r.auth) : undefined;
  if (oauthPolicy) r.auth.parameterPolicy = oauthPolicy;
  const raw = serializeRequestPath(r);
  if (r.auth.type === "aws" && r.auth.addAuthDataToQuery === true)
    validateAWSQueryURL(raw);
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol))
    throw Error("仅支持 HTTP/HTTPS");
  if (u.username || u.password) throw Error("请在认证面板配置凭据");
  appendRequestQuery(u, r.query, r.queryAddEqual);
  const headers = requestHeaderMap(r.headers, r.auth.type);
  validateRedirectAdmission(r, headers);
  if (r.redirect && Buffer.byteLength(u.href) > 8192)
    throw Error("redirect URL 超过 8 KiB");
  const tokenPolicy =
    applyPostmanOAuth2(u, headers, r.auth) ||
    applyNativeOAuth2(u, headers, r.auth);
  if (!tokenPolicy && (r.auth.type === "bearer" || r.auth.type === "oauth2")) {
    if (!r.auth.token) throw Error("请填写或获取 Bearer Token");
    headers.authorization = "Bearer " + r.auth.token;
  }
  if (r.auth.type === "basic")
    headers.authorization =
      "Basic " +
      Buffer.from(`${r.auth.username || ""}:${r.auth.password || ""}`).toString(
        "base64",
      );
  if (r.auth.type === "apiKey") {
    if (r.auth.in === "query") setAPIKeyQuery(u, r.auth);
    // Keep auth overrides in the same case-insensitive map as request rows
    // before body defaults, computed framing and signing inspect it.
    else headers[String(r.auth.key).toLowerCase()] = r.auth.value;
  }
  if (r.auth.type === "asap")
    headers.authorization = (await asapAuthorization(r.auth)).value;
  if (r.auth.type === "jwt") {
    const jwt = await jwtAuthorization(r.auth);
    if (jwt.in === "query") setURLQuery(u, jwt.key, jwt.value);
    else headers[jwt.key] = jwt.value;
  }
  const cookieHeader = requestCookieHeader(r.cookies, r.cookieEncoding);
  if (cookieHeader !== undefined) headers.cookie = cookieHeader;
  if (cookieSession) {
    const managed = await cookieSession.header(u.href, controls);
    if (managed !== null) {
      if (managed) headers.cookie = managed;
      else delete headers.cookie;
    }
  }
  let body;
  if (replay) {
    body = replay.body;
    if (replay.contentType !== undefined)
      headers["content-type"] = replay.contentType;
  } else if (r.bodyType === "msgpack") {
    const { encode } = await import("@msgpack/msgpack");
    body = Buffer.from(encode(JSON.parse(r.body || "{}"), { maxDepth: 64 }));
    headers["content-type"] ??= "application/msgpack";
  } else if (r.bodyType === "json") {
    JSON.parse(r.body || "{}");
    body = r.body || "{}";
    headers["content-type"] ??= "application/json";
  } else if (r.bodyType === "urlencoded") {
    body = new URLSearchParams(
      r.form.filter((f) => f.enabled !== false).map((f) => [f.key, f.value]),
    ).toString();
    headers["content-type"] ??= "application/x-www-form-urlencoded";
  } else if (r.bodyType === "form-data") {
    const boundary = "----localapi" + id(),
      chunks = [];
    for (const field of r.form.filter((f) => f.enabled !== false)) {
      if (field.requiresFile)
        throw Error("请重新选择导入的文件: " + field.filename);
      const name = String(field.key).replace(/["\r\n]/g, "");
      const filename =
        field.type === "file"
          ? String(field.filename || "file").replace(/["\r\n]/g, "")
          : null;
      const partMedia = multipartPartMedia(field, Boolean(filename));
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ""}\r\n${partMedia === undefined ? "" : "Content-Type: " + partMedia + "\r\n"}\r\n`,
        ),
      );
      chunks.push(
        filename
          ? Buffer.from(field.value || "", "base64")
          : Buffer.from(String(field.value ?? "")),
      );
      chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    body = Buffer.concat(chunks);
    headers["content-type"] = "multipart/form-data; boundary=" + boundary;
  } else if (r.bodyType === "binary") {
    body = Buffer.from(r.body, "base64");
  } else if (r.bodyType !== "none") body = r.body;
  applyPostmanRawMedia(r, headers, body);
  if (body && Buffer.byteLength(body) > 8 * 1024 * 1024)
    throw Error("请求体超过 8 MiB");
  if (body) headers["content-length"] = Buffer.byteLength(body);
  if (r.auth.type === "oauth1") {
    const signed = oauth1Request(u.href, r.method, headers, body, r.auth, {
      bodyType: r.bodyType,
    });
    u.href = signed.url;
    body = signed.body;
    delete headers.authorization;
    Object.assign(headers, signed.headers);
  }
  if (r.auth.type === "aws") {
    const signed = await awsSignatureRequest(
      u.href,
      r.method,
      headers,
      body,
      r.auth,
    );
    u.href = signed.url;
    // Query signing removes/hoists authentication headers. Object.assign alone
    // would leave old Authorization or session-token headers on the wire.
    if (r.auth.addAuthDataToQuery === true)
      for (const key of Object.keys(headers)) delete headers[key];
    Object.assign(headers, signed.headers);
  }
  if (r.auth.type === "hawk")
    headers.authorization = hawkAuthorization(
      u.href,
      r.method,
      headers,
      body,
      r.auth,
    ).header;
  if (r.auth.type === "edgegrid")
    headers.authorization = edgegridAuthorization(
      u.href,
      r.method,
      headers,
      body,
      r.auth,
    );
  if (r.auth.type === "ntlm") {
    headers.authorization = ntlmType1(r.auth);
    headers.connection = "keep-alive";
  }
  throwIfInactive(controls);
  if (r.redirect) validatePreparedRedirectHeaders(headers);
  if (r.redirect)
    return executePreparedRedirect(
      r,
      u,
      headers,
      body,
      controls,
      cookieSession,
      (response) =>
        captureResponseHeaderEvidence(
          response,
          response.rawHeaders,
          response.protocol,
        ),
    );
  const start = performance.now();
  const connectionBudget = deadline - performance.now();
  if (connectionBudget <= 0) throw requestTimeout();
  const connection = await prepareConnection(
    u,
    { ...r, timeout: Math.min(r.timeout, connectionBudget) },
    headers,
    signal,
  );
  let authSocket;
  const requestOnce = async (headers, expectedSocket) => {
    throwIfInactive(controls);
    const remainingTimeout = deadline - performance.now();
    if (remainingTimeout <= 0) throw requestTimeout();
    return await new Promise((resolve, reject) => {
      const req = connection.client.request(
        connection.url,
        { method: r.method, headers, signal, ...connection.options },
        (res) => {
          const chunks = [];
          let size = 0;
          const decoder = responseContentDecoder(
            r.method,
            res.statusCode,
            res.headers["content-encoding"],
          );
          const stream = decoder ? res.pipe(decoder) : res;
          if (decoder) res.on("error", (e) => decoder.destroy(e));
          stream.on("data", (c) => {
            size += c.length;
            if (size > 8 * 1024 * 1024) {
              stream.destroy(Error("响应超过 8 MiB"));
              res.destroy();
              req.destroy();
            } else chunks.push(c);
          });
          stream.on("error", (error) => {
            clearTimeout(totalTimer);
            reject(error);
          });
          stream.on("end", async () => {
            clearTimeout(totalTimer);
            const raw = Buffer.concat(chunks);
            let displayBody = raw.toString("utf8"),
              rawBodyBase64,
              codecError;
            if (isMessagePackResponseType(res.headers["content-type"])) {
              rawBodyBase64 = raw.toString("base64");
              try {
                const { decode } = await import("@msgpack/msgpack");
                displayBody = JSON.stringify(
                  decode(raw, {
                    useBigInt64: true,
                    maxStrLength: 8388608,
                    maxBinLength: 8388608,
                    maxArrayLength: 100000,
                    maxMapLength: 100000,
                    maxExtLength: 8388608,
                  }),
                  (_key, value) =>
                    typeof value === "bigint"
                      ? value.toString()
                      : value instanceof Uint8Array
                        ? {
                            type: "binary",
                            base64: Buffer.from(value).toString("base64"),
                          }
                        : value,
                  null,
                  2,
                );
              } catch (error) {
                codecError = error.message;
                displayBody = rawBodyBase64;
              }
            }
            resolve(
              captureResponseHeaderEvidence(
                {
                  status: res.statusCode,
                  protocol: res.httpVersion || "1.1",
                  statusText: res.statusMessage,
                  headers: res.headers,
                  body: displayBody,
                  rawBodyBase64,
                  codecError,
                  size,
                  duration: Math.round((performance.now() - start) * 100) / 100,
                  request: {
                    method: r.method,
                    url: u.href,
                    headers: { ...headers },
                    body: body?.toString() || "",
                  },
                },
                res.rawHeaders,
                res.httpVersion,
              ),
            );
          });
        },
      );
      // Keep Node's existing default range visible to ordinary requests. Set the
      // public parser cap before socket/parser binding, never the smaller native
      // extraction cap. Saturated/oversized evidence is rejected independently.
      if (r.httpVersion !== "2") req.maxHeadersCount = HTTP1_HEADER_PAIR_LIMIT;
      const totalTimer = setTimeout(
        () => req.destroy(requestTimeout()),
        remainingTimeout,
      );
      req.setTimeout(remainingTimeout, () => req.destroy(requestTimeout()));
      req.on("error", (error) => {
        clearTimeout(totalTimer);
        reject(error);
      });
      const sendBody = () => {
        if (body) req.write(body);
        req.end();
      };
      if (r.auth.type === "ntlm")
        req.once("socket", (socket) => {
          if (expectedSocket && socket !== expectedSocket) {
            req.destroy(Error("NTLM连接已更换，拒绝重放凭据"));
            return;
          }
          authSocket = socket;
          sendBody();
        });
      else sendBody();
    });
  };
  const response = await (async () => {
    const first = await requestOnce(headers);
    if (r.auth.type !== "ntlm" || first.status !== 401) return first;
    const challenge = parseNtlmChallenge(first.headers["www-authenticate"]);
    if (
      !authSocket ||
      authSocket.destroyed ||
      String(first.headers.connection || "").toLowerCase() === "close"
    )
      throw Error("NTLM服务器关闭连接，拒绝重放凭据");
    const authenticatedHeaders = {
      ...headers,
      authorization: ntlmType3(challenge, r.auth, headers.authorization),
    };
    try {
      throwIfInactive(controls);
      if (cookieSession) {
        await cookieSession.capture(
          u.href,
          first.headers["set-cookie"],
          controls,
        );
        const managed = await cookieSession.header(u.href, controls);
        if (managed !== null) {
          if (managed) authenticatedHeaders.cookie = managed;
          else delete authenticatedHeaders.cookie;
        }
      }
      throwIfInactive(controls);
    } catch (error) {
      if (interruptionKind(error))
        throw httpFinalizationFailure(first, error, "auth-cookie");
      throw error;
    }
    const final = await requestOnce(authenticatedHeaders, authSocket);
    final.authHandshake = {
      status: first.status,
      duration: first.duration,
      roundTrips: 2,
      protocol: "NTLMv2",
    };
    return final;
  })().finally(() => connection.cleanup());
  try {
    throwIfInactive(controls);
    if (cookieSession)
      await cookieSession.capture(
        u.href,
        response.headers["set-cookie"],
        controls,
      );
    throwIfInactive(controls);
  } catch (error) {
    if (interruptionKind(error))
      throw httpFinalizationFailure(
        response,
        error,
        cookieSession ? "cookie-capture" : "response-finalization",
      );
    // Ordinary persistence errors remain warnings, but cannot mask an abort
    // that arrived during the same filesystem operation.
    try {
      throwIfInactive(controls);
    } catch (interruption) {
      throw httpFinalizationFailure(response, interruption);
    }
    response.cookieError = "Cookie保存失败：" + error.message;
  }
  if (
    r.auth.type === "digest" &&
    response.status === 401 &&
    digestPolicy?.retry !== false
  ) {
    throwIfInactive(controls);
    const authorization = digestAuthorization(
      response.headers["www-authenticate"],
      r.auth,
      r.method,
      u.pathname + u.search,
      body || "",
    );
    if (authorization === null) return response;
    const authenticated = await executeRequestWithinDeadline(
      {
        ...r,
        auth: { type: "none" },
        headers: [
          ...r.headers.filter(
            (header) => header.key.toLowerCase() !== "authorization",
          ),
          { key: "Authorization", value: authorization, enabled: true },
        ],
      },
      signal,
      cookieSession,
      deadline,
      { body, contentType: headers["content-type"] },
    ).catch((error) => {
      // Retain newer evidence (e.g. final 200 capture) before consulting controls.
      if (readHttpFinalizationFailure(error)) throw error;
      if (interruptionKind(error))
        throw httpFinalizationFailure(response, error, "auth-cookie");
      // Native transport AbortErrors are not our branded interruptions. Use the
      // actual controls, never an arbitrary error.code/response, to classify.
      try {
        throwIfInactive(controls);
      } catch (interruption) {
        throw httpFinalizationFailure(response, interruption, "auth-cookie");
      }
      throw error;
    });
    authenticated.authHandshake = {
      status: response.status,
      duration: response.duration,
    };
    return authenticated;
  }
  return response;
}
