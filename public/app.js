import { renderWorkspaceTree } from "./api-sidebar-tree.js";
import { bindPlanPickerTree } from "./plan-step-picker.js";
import { unsentResponseData } from "./http-response-empty.js";
import {
  httpResponseTabs,
  readResponseTabsPosition,
  restoreResponseTabsPosition,
} from "./http-response-tabs.js";
import {
  requestParameterTabs,
  revealParameterTab,
} from "./http-request-parameter-tabs.js";
import {
  debugPairComposer,
  debugPairFromKey,
  debugQueryEquality,
  debugQueryEqualityLabel,
  ownsDebugPairComposer,
} from "./debug-pair-composer.js";
import {
  httpRequestActions,
  requestCurlAction,
} from "./http-request-actions.js";
import {
  designResponsePanel,
  responseSelection,
  editDesignResponseHeader,
  editDesignResponseRoot,
  responseRootTypeFields,
  headerEditorFields,
  exampleMedia,
  scopedResponseExamples,
  supportsDesignExamples,
} from "./design-response.js";
import {
  documentCounts,
  documentWorkspaceTabs,
  prepareWorkspaceDocumentLinks,
  workspaceDocumentById,
  workspaceDocumentHTML,
} from "./workspace-document.js";
import { bindWorkspaceDocumentScroll } from "./workspace-document-scroll.js";
import { markdownEdit, markdownTools } from "./design-markdown.js";
import { insertTextareaText } from "./textarea-edit-history.js";
import { emptyCasePanel } from "./case-empty-view.js";
import {
  cookieManagerHTML,
  environmentDialogHTML,
  environmentDialogShell,
  mountEnvironmentDialog,
} from "./environment-dialog.js";
import { bindMCPDatabase } from "./mcp-database-view.js";
import {
  loadDatabasePreviewCapabilities,
  isPreviewDatabase,
  readDatabasePreviewConnection,
} from "./sqlserver-preview-ui.js";
import {
  capturePlanHistoryFocus,
  restorePlanHistoryFocus,
} from "./plan-history-focus.js";
import {
  protocolHistoryView,
  applyProtocolHistoryFilters,
  protocolHistoryDetail,
  prepareProtocolHistoryExport,
} from "./protocol-history-view.js";
import {
  createGrpcStreamState,
  renderGrpcStream,
  bindGrpcStream,
  invalidateGrpcStream,
} from "./grpc-stream-workbench.js";
import {
  createSocketIOState,
  selectSocketIO,
  invalidateSocketIO,
  renderSocketIO,
  bindSocketIO,
} from "./socketio-workbench.js";
import {
  createGrpcUnaryState,
  renderGrpcUnary,
  bindGrpcUnary,
  selectGrpcUnary,
  invalidateGrpcUnary,
} from "./grpc-unary-workbench.js";
import {
  scopedExportResources,
  scopedExportSelectionHTML,
  readScopedExportInput,
  assertScopedExportPreview,
  scopedExportConfirmationHTML,
  scopedExportRequest,
  assertScopedExportResult,
} from "./scoped-export-view.js";
import { createProtocolSessionController } from "./protocol-session-controller.js";
import {
  planStructureEditor,
  bindPlanStructureEditor,
} from "./plan-structure-editor.js";
import { createProjectImportGuard } from "./project-import-guard.js";
const projectImports = createProjectImportGuard();
import { createNativeRequestLifecycle } from "./native-request-lifecycle.js";
const nativeRequestLifecycle = createNativeRequestLifecycle();
let projectOpenSequence = 0;
let bodyGenerationSequence = 0;
import { mysqlPortInput, mongoPortInput } from "./mysql-port-input.js";
import { parseDatabaseParameterJSON } from "./database-parameter-json.js";
import {
  parseApipostFunctionTemplate,
  isApipostFunctionSource,
  apipostFunctionSourceGroups,
} from "./apipost-function-template.js";
import { selectedDirectoryDocument } from "./apipost-directory-input.js";
import { createCaseResultStore } from "./case-result-store.js";
import { runCaseBatch, caseEvidence } from "./case-batch.js";
import { moveSelectedCases, deleteSelectedCases } from "./case-selection.js";
import {
  caseCards,
  caseRunOrder,
  caseFolderPath,
  saveCaseFolder,
  removeEmptyCaseFolder,
} from "./case-folders.js";
import {
  validateParameterDescriptions,
  parameterDescriptionChoices,
} from "./parameter-descriptions.js";
import { importedScriptTasksHTML } from "./imported-script-tasks.js";
import {
  scriptURLModeOptions,
  scriptURLModeNotice,
} from "./script-url-mode.js";
import { assertionCounts } from "./assertion-state.js";
import { createScriptDraft, applyScriptDraft } from "./script-draft.js";
import { mockURL, mockDebugTarget } from "./mock-target.js";
import { editResponseExample } from "./response-example.js";
import { applySelectedFormFile } from "./form-file-selection.js";
import { variableRows } from "./variable-definitions.js";
import {
  globalParameterWorkspaceIssue,
  mountWorkspaceGlobalParameters,
  workspaceGlobalParametersHTML,
} from "./workspace-global-parameters.js";
import { mountVariableEditor } from "./variable-editor.js";
import {
  mountWorkspaceGlobalVariables,
  workspaceGlobalVariablesHTML,
} from "./workspace-global-variables.js";
import {
  inferSchemaFromJSON,
  inferSchemaFromMySQL,
  inferSchemaFromXML,
} from "./schema-inference.js";
import {
  saveModelFolder,
  removeEmptyModelFolder,
} from "./model-folder-actions.js";
import { saveModel } from "./model-edit.js";
import { modelCards, modelFolderPath } from "./model-folders.js";
import { bindMCPSettings } from "./mcp-settings-view.js";
import { scriptDialectOptions, scriptDialectNotice } from "./script-dialect.js";
import { mountVisualization } from "./visualizer-view.js";
import { bindLocalDocumentImage } from "./document-local-image.js";
import { moveFolderTree } from "./folder-tree.js";
import { loadTiming } from "./load-timing.js";
import { parseLoadCSV } from "./load-data.js";
import { builtinVariableNames } from "./builtin-variable-catalog.js";
import {
  schemaEditor,
  bindSchemaEditor,
  editRequestResponseDefinition,
  editRequestResponseSettings,
} from "./schema-editor.js";
import { httpAuthPane, httpDebugAuthPane } from "./auth-view.js";
import {
  captureDebugAuthOperation,
  debugAuthChoice,
  updateDebugAuthChoice,
  usesDebugAuthChoice,
} from "./debug-auth-choice.js";
import { renderMarkdown } from "./vendor/markdown-renderer.js";
import { attributeFields, attributeChooser } from "./attribute-view.js";
import {
  attributeInputValue,
  validateAttributeDefinitions,
  validateAttributeValues,
  attributeTypes,
} from "./attribute-model.js";
import { errorCodeHTML } from "./error-code-view.js";
import { settingsPanel } from "./settings-view.js";
import { adoptVariableWrites } from "./variable-write-receipt.js";
import { stepEditor, bindStepEditor } from "./step-editor.js";
import {
  dictionaryPanel,
  dictionaryValue,
  insertDictionaryField,
  effectiveParameterDictionary,
} from "./dictionary-view.js";
import { clientConfiguration, mcpClients } from "./mcp-client-config.js";
import { renderPlans, renderRuns } from "./plan-view.js";
import { createPlanHistoryRefresh } from "./plan-history-refresh.js";
const refreshPlanHistory = createPlanHistoryRefresh();
import { resources, settingsSidebar } from "./resource-view.js";
import { highlightJSON } from "./code-format.js";
import { snapshotInterfaceForPlan } from "./plan-snapshots.js";
import {
  exportDocumentation,
  requestDocumentationHTML,
} from "./document-export.js";
import { icon as lineIcon } from "./icons.js";
const $ = (s) => document.querySelector(s),
  esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const uid = () => crypto.randomUUID();
const responses = new Map();
const openDesignDescriptions = new WeakMap();
const designParameterTabs = [
  ["headers", "Header"],
  ["query", "Query"],
  ["path", "Path"],
  ["body", "Body"],
  ["auth", "认证"],
];
let designParameter = "headers";
const designResponseSelections = new Map();
const collapsedDesignResponseRoots = new WeakMap();
const debugAuthDrafts = new WeakMap();
const designResponseKey = (r) => JSON.stringify([project?.id, r.id]);
const caseResults = createCaseResultStore();
const caseSelections = new Map();
let caseBatch = null;
let singleCaseRun = null;
function caseCancellationOwner() {
  return caseBatch?.running ? caseBatch : singleCaseRun;
}
function canCancelCurrentCase() {
  const owner = caseCancellationOwner();
  return (
    mode === "cases" &&
    owner?.projectId === project.id &&
    owner?.sourceRequestId === current
  );
}
function selectedInterfaceCases() {
  const key = project.id + ":" + current;
  const eligible = new Set(
    (project.cases || [])
      .filter((c) => c.sourceRequestId === current)
      .map((c) => c.id),
  );
  const selected = new Set(
    [...(caseSelections.get(key) || [])].filter((id) => eligible.has(id)),
  );
  caseSelections.set(key, selected);
  return selected;
}
function caseSelectionToolbar() {
  const selected = selectedInterfaceCases(),
    all = (project.cases || []).filter((c) => c.sourceRequestId === current);
  return `<div class="toolbar case-selection"><label><input type="checkbox" id="select-all-cases" ${all.length && selected.size === all.length ? "checked" : ""} ${busy || !all.length ? "disabled" : ""}> 全选</label><span role="status">已选 ${selected.size} 项</span><button id="run-selected-cases" ${busy || !selected.size ? "disabled" : ""}>运行所选</button><button id="run-all-cases" ${busy || !all.length ? "disabled" : ""}>全部运行</button>${canCancelCurrentCase() ? '<button type="button" id="cancel-case-run">取消运行</button>' : ""}<button id="move-selected-cases" ${busy || !selected.size ? "disabled" : ""}>移动所选</button><button id="delete-selected-cases" class="danger" ${busy || !selected.size ? "disabled" : ""}>删除所选</button></div><p class="muted">单次最多100个、请求快照总量4MiB，按当前列表顺序串行运行；用例未通过会继续，调用错误会停止且不重试。取消会停止后续用例。</p>${caseBatch?.projectId === project.id && caseBatch?.sourceRequestId === current ? `<p id="case-batch-status" role="status">${caseBatch.running ? "运行中" : caseBatch.cancelled ? "已取消" : caseBatch.stoppedOnError ? "已停止（调用错误）" : "已完成"} ${caseBatch.completed} / ${caseBatch.total} · 通过 ${caseBatch.passed} · 未通过 ${caseBatch.failed}${caseBatch.currentName ? " · " + esc(caseBatch.currentName) : ""}</p>` : ""}`;
}
const temporaryParameters = new Map();
const collapsedFolders = new Set();
const loadOptions = new Map();
const parameterScopes = new Map();
const pendingOAuth1 = new Set();
let openedDocuments = [];
let activeDocumentId = null;
const documentModes = new Map();
let modalRevision = 0;
let modalFocusHandlers;
let opened = [],
  token = "",
  projects = [],
  project = null,
  current = null,
  page = "apis",
  mode = "debug",
  param = "body",
  responseTab = "body",
  response = null,
  dirty = false,
  saving = false,
  editVersion = 0,
  busy = false,
  runId = "",
  search = "",
  searchType = "all",
  selectedProtocolId = "",
  planId = "",
  planTab = "plans",
  lastRun = null,
  loadResult = null,
  activeSession = null,
  sessionController = null,
  sessionState = {
    phase: "idle",
    warning: "",
    canConnect: false,
    canSend: false,
    canStop: false,
  },
  mcpState = { enabled: false, activities: [] },
  updateMCPPanel = null,
  mcpPollSequence = 0,
  helperOpen = false,
  bodyExpanded = false,
  responseLayout = "stacked",
  compactUI = false,
  settingsSection = "settings-basic";
let socketioWorkbenchState = null,
  socketioWorkbenchProject = "",
  socketioNavigationGeneration = 0,
  socketioWasVisible = false,
  socketioBusyToken = null;
const socketioProjectStates = new Map();
const socketioActiveOperations = new Map();
function socketioEvidenceKey(id) {
  return "socketio-evidence-v1:" + id;
}
function persistSocketIOEvidence(id, state) {
  sessionStorage.setItem(
    socketioEvidenceKey(id),
    JSON.stringify({
      version: 1,
      pendingAckRecovery: state.pendingAckRecovery || null,
      pendingSendRecovery: state.pendingSendRecovery || null,
      creationIntent: state.creationIntent || null,
      uncertainStart: !!state.uncertainStart,
      uncertainSessions: state.uncertainSessions,
      stopProblems: state.stopProblems,
      sessionId: state.session?.id || null,
      sessionClosed:
        state.session?.state === "closed" || state.session?.state === "error",
    }),
  );
  return true;
}
function restoreSocketIOEvidence(id, state) {
  try {
    const raw = sessionStorage.getItem(socketioEvidenceKey(id));
    if (!raw) return;
    const value = JSON.parse(raw);
    const boundedId = (id) =>
      typeof id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(id);
    const uuid = (id) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
    if (
      value.version !== 1 ||
      (value.creationIntent != null &&
        (!uuid(value.creationIntent.instanceId) ||
          !uuid(value.creationIntent.intentId) ||
          !boundedId(value.creationIntent.definitionId))) ||
      (value.pendingSendRecovery != null &&
        (!uuid(value.pendingSendRecovery.id) ||
          !boundedId(value.pendingSendRecovery.sessionId) ||
          !Number.isSafeInteger(value.pendingSendRecovery.sequence) ||
          value.pendingSendRecovery.sequence < 1)) ||
      (value.pendingAckRecovery != null &&
        (typeof value.pendingAckRecovery !== "object" ||
          [
            value.pendingAckRecovery.sessionId,
            value.pendingAckRecovery.ackId,
          ].some(
            (x) => typeof x !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(x),
          ))) ||
      typeof value.uncertainStart !== "boolean" ||
      !Array.isArray(value.uncertainSessions) ||
      value.uncertainSessions.some(
        (x) => typeof x !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(x),
      ) ||
      value.uncertainSessions.length > 100 ||
      !Array.isArray(value.stopProblems) ||
      value.stopProblems.length > 100 ||
      value.stopProblems.some(
        (x) => typeof x !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(x),
      ) ||
      (value.sessionId !== null &&
        (typeof value.sessionId !== "string" ||
          !/^[A-Za-z0-9_-]{1,200}$/.test(value.sessionId)))
    )
      throw Error("无效恢复记录");
    if (value.creationIntent) {
      const { instanceId, intentId, definitionId } = value.creationIntent;
      state.creationIntent = { instanceId, intentId, definitionId };
    }
    if (value.pendingSendRecovery) {
      const { id, sequence, sessionId } = value.pendingSendRecovery;
      state.pendingSendRecovery = { id, sequence, sessionId };
    }
    state.pendingAckRecovery = value.pendingAckRecovery
      ? {
          sessionId: value.pendingAckRecovery.sessionId,
          ackId: value.pendingAckRecovery.ackId,
        }
      : null;
    state.uncertainStart = value.uncertainStart;
    state.uncertainSessions = value.uncertainSessions;
    state.stopProblems = value.stopProblems;
    if (value.sessionId)
      state.session = {
        id: value.sessionId,
        type: "socketio",
        state: value.sessionClosed ? "closed" : "connecting",
        events: [],
        definition: {},
      };
    state.notice =
      "已恢复本页操作标记；状态尚未核实，请只读刷新或列出会话。不会自动重连或重发。";
  } catch {
    state.uncertainStart = true;
    state.notice =
      "无法读取操作恢复标记，新连接已阻止。请核对原服务会话，不会自动重试。";
  }
}
function syncSocketIOWorkbench() {
  if (socketioWorkbenchProject !== project?.id) {
    if (socketioWorkbenchState) invalidateSocketIO(socketioWorkbenchState);
    socketioWorkbenchProject = project?.id || "";
    socketioWorkbenchState = socketioProjectStates.get(
      socketioWorkbenchProject,
    );
    if (!socketioWorkbenchState) {
      socketioWorkbenchState = createSocketIOState();
      restoreSocketIOEvidence(socketioWorkbenchProject, socketioWorkbenchState);
      socketioProjectStates.set(
        socketioWorkbenchProject,
        socketioWorkbenchState,
      );
    }
    socketioNavigationGeneration++;
  }
  if (socketioWasVisible && page !== "socketio") {
    invalidateSocketIO(socketioWorkbenchState);
    socketioNavigationGeneration++;
  }
  socketioWasVisible = page === "socketio";
}
function bindSocketIOWorkbench() {
  const root = $("#socketio-workbench");
  if (!root) return;
  const state = socketioWorkbenchState,
    navigation = socketioNavigationGeneration;
  let owner = project,
    version = editVersion,
    ownBusy = null;
  const current = () => {
    if (
      project !== owner ||
      editVersion !== version ||
      page !== "socketio" ||
      socketioWorkbenchState !== state ||
      socketioNavigationGeneration !== navigation
    )
      throw Error("项目或面板已变化，未应用迟到结果");
  };
  const rebindSaved = () => {
    if (project?.id === owner.id && socketioWorkbenchState === state) {
      owner = project;
      version = editVersion;
    }
  };
  bindSocketIO(root, {
    ownerReceipts: true,
    state,
    definitions: project.settings?.socketioDefinitions || [],
    uid,
    confirmDiscard: () =>
      confirm("当前Socket.IO定义草稿未保存，确定切换定义？"),
    assertCurrent: current,
    persistEvidence: (value) => persistSocketIOEvidence(owner.id, value),
    onChange: () => {
      if (
        page === "socketio" &&
        socketioWorkbenchState === state &&
        socketioNavigationGeneration === navigation
      )
        render();
    },
    setBusy: (value, kind) => {
      if (value) {
        current();
        if (busy || saving) throw Error("请等待当前请求或保存结束");
        if (["connect", "send", "ack", "save"].includes(kind)) {
          if (state.stopProblems.length)
            throw Error(
              "前次停止或记录保存仍需核对；请先只读刷新或显式停止保存，未开始新操作",
            );
          nativeRequestLifecycle.assertCanSave(owner.id);
          projectImports.assertCanSave(owner.id);
          if (dirty) throw Error("项目有未保存修改；请先保存，未自动保存");
        }
        ownBusy = { state };
        socketioBusyToken = ownBusy;
        busy = true;
      } else if (
        socketioBusyToken?.state === state &&
        !state.pending &&
        !state.stopPending
      ) {
        socketioBusyToken = null;
        ownBusy = null;
        busy = false;
      }
    },
    get: (action) => {
      current();
      if (
        !/^socketio-sessions(?:\/[A-Za-z0-9_-]+)?$/.test(action) &&
        !/^socketio-creation-intents\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(
          action,
        )
      )
        throw Error("未知Socket.IO读取");
      return api("/projects/" + owner.id + "/" + action);
    },
    post: async (action, body) => {
      current();
      if (action === "socketio-creation-intents")
        return api("/projects/" + owner.id + "/" + action, "POST", body);
      if (
        !/^socketio-sessions(?:\/[A-Za-z0-9_-]+\/(?:send|ack|stop))?$/.test(
          action,
        )
      )
        throw Error("未知Socket.IO操作");
      const stopping = action.endsWith("/stop");
      // A stop must remain possible while send is pending, or after uncertainty.
      const sharedOperation = stopping
        ? socketioActiveOperations.get(owner.id)
        : null;
      const operation =
        sharedOperation ||
        (stopping
          ? projectImports.beginRecovery(owner.id)
          : projectImports.begin(owner.id, "execution"));
      if (!stopping) socketioActiveOperations.set(owner.id, operation);
      try {
        const result = await api(
          "/projects/" + owner.id + "/" + action,
          "POST",
          body,
        );
        if (stopping && result?.recordSaved !== true)
          operation?.requireReconciliation();
        return result;
      } catch (error) {
        operation?.requireReconciliation();
        throw error;
      } finally {
        if (!sharedOperation) {
          operation.finish();
          if (socketioActiveOperations.get(owner.id) === operation)
            socketioActiveOperations.delete(owner.id);
        }
      }
    },
    saveDefinition: async (definition) => {
      current();
      if (dirty) throw Error("项目有未保存修改；未自动保存其他草稿");
      const previous = owner.settings?.socketioDefinitions;
      owner.settings ??= {};
      owner.settings.socketioDefinitions = [
        ...(previous || []).filter((item) => item.id !== definition.id),
        structuredClone(definition),
      ];
      mark();
      try {
        await save();
        rebindSaved();
        return project.settings.socketioDefinitions.find(
          (item) => item.id === definition.id,
        );
      } catch (error) {
        rollbackProjectSave(error, () => {
          if (previous === undefined) delete owner.settings.socketioDefinitions;
          else owner.settings.socketioDefinitions = previous;
        });
        rebindSaved();
        throw error;
      }
    },
  });
}

let grpcWorkbenchState = null,
  grpcWorkbenchProject = "",
  grpcNavigationGeneration = 0,
  grpcWasVisible = false,
  grpcBusyToken = null;
function syncGrpcWorkbench() {
  if (grpcWorkbenchProject !== project?.id) {
    if (grpcWorkbenchState) invalidateGrpcUnary(grpcWorkbenchState);
    grpcWorkbenchState = createGrpcUnaryState();
    grpcWorkbenchProject = project?.id || "";
    grpcNavigationGeneration++;
  }
  if (grpcWasVisible && page !== "grpc") {
    invalidateGrpcUnary(grpcWorkbenchState);
    grpcNavigationGeneration++;
  }
  grpcWasVisible = page === "grpc";
}
function bindGrpcWorkbench() {
  const root = $("#grpc-unary-workbench");
  if (!root) return;
  const state = grpcWorkbenchState,
    navigation = grpcNavigationGeneration;
  let owner = project,
    version = editVersion,
    ownBusy = null;
  const current = () => {
    if (
      project !== owner ||
      editVersion !== version ||
      page !== "grpc" ||
      grpcWorkbenchState !== state ||
      grpcNavigationGeneration !== navigation
    )
      throw Error("项目或面板已变化，未应用迟到结果");
  };
  const assertCanStart = () => {
    current();
    if (saving) throw Error("请等待项目保存结束");
    nativeRequestLifecycle.assertCanSave(owner.id);
    projectImports.assertCanSave(owner.id);
  };
  const rebindSaved = () => {
    if (project?.id === owner.id && grpcWorkbenchState === state) {
      owner = project;
      version = editVersion;
    }
  };
  bindGrpcUnary(root, {
    state,
    definitions: project.settings?.grpcDefinitions || [],
    uid,
    confirmDiscard: () => confirm("当前gRPC定义草稿未保存，确定切换定义？"),
    assertCurrent: current,
    onChange: () => {
      if (
        page === "grpc" &&
        grpcWorkbenchState === state &&
        grpcNavigationGeneration === navigation
      )
        render();
    },
    setBusy: (value) => {
      if (value) {
        assertCanStart();
        if (busy || saving) throw Error("请等待当前请求或保存结束");
        if (dirty)
          throw Error("项目有未保存修改；请先保存后重新操作，未自动保存");
        ownBusy = {};
        grpcBusyToken = ownBusy;
        busy = true;
      } else if (ownBusy && grpcBusyToken === ownBusy) {
        grpcBusyToken = null;
        ownBusy = null;
        busy = false;
      }
    },
    post: async (action, body) => {
      current();
      if (
        ![
          "grpc-schema",
          "grpc-request-example",
          "grpc-reflection",
          "grpc-run",
        ].includes(action)
      )
        throw Error("未知gRPC操作");
      const network = action === "grpc-run" || action === "grpc-reflection";
      const operation = network
        ? projectImports.begin(owner.id, "execution")
        : null;
      try {
        const result = await api(
          "/projects/" + owner.id + "/" + action,
          "POST",
          body,
        );
        if (action === "grpc-run" && result?.recordSaved !== true)
          operation.requireReconciliation();
        return result;
      } catch (error) {
        if (action === "grpc-run") operation.requireReconciliation();
        throw error;
      } finally {
        operation?.finish();
      }
    },
    cancelRun: (runId) => api("/cancel", "POST", { id: runId }),
    saveDefinition: async (definition) => {
      current();
      if (dirty) throw Error("项目有未保存修改；未自动保存其他草稿");
      const previous = owner.settings?.grpcDefinitions;
      const next = (previous || []).filter((item) => item.id !== definition.id);
      next.push(structuredClone(definition));
      owner.settings ??= {};
      owner.settings.grpcDefinitions = next;
      mark();
      try {
        await save();
        rebindSaved();
        return project.settings.grpcDefinitions.find(
          (item) => item.id === definition.id,
        );
      } catch (error) {
        rollbackProjectSave(error, () => {
          if (previous === undefined) delete owner.settings.grpcDefinitions;
          else owner.settings.grpcDefinitions = previous;
        });
        rebindSaved();
        throw error;
      }
    },
  });
}
let grpcStreamState = null,
  grpcStreamProject = "",
  grpcStreamOwner = null,
  grpcStreamGeneration = 0,
  grpcStreamVisible = false,
  grpcStreamBusyToken = null;
const grpcStreamProjectStates = new Map();
const grpcStreamOperations = new Map();
function persistGrpcStreamEvidence(id, state) {
  sessionStorage.setItem(
    "grpc-stream-evidence-v1:" + id,
    JSON.stringify({
      version: 1,
      definitionId: state.definitionId || "",
      sessionId: state.sessionId || "",
      sessionIdKnown: !!state.sessionIdKnown,
      uncertainStart: !!state.uncertainStart,
      startRecoveryId: state.startRecoveryId || "",
      creationIntentId: state.creationIntentId || "",
      creationInstanceId: state.creationInstanceId || "",
      pendingOwnerOperation: state.pendingOwnerOperation || null,
      uncertainSessions: state.uncertainSessions,
      persistenceProblems: state.persistenceProblems,
    }),
  );
  return true;
}
function restoreGrpcStreamEvidence(id, state) {
  try {
    const raw = sessionStorage.getItem("grpc-stream-evidence-v1:" + id);
    if (!raw) return;
    const value = JSON.parse(raw),
      validId = (x) =>
        typeof x === "string" && /^[A-Za-z0-9_-]{0,200}$/.test(x);
    if (
      value.version !== 1 ||
      !validId(value.definitionId) ||
      !validId(value.sessionId) ||
      (value.startRecoveryId !== undefined &&
        !validId(value.startRecoveryId)) ||
      [value.creationIntentId, value.creationInstanceId].some(
        (x) => x !== undefined && !validId(x),
      ) ||
      (value.pendingOwnerOperation != null &&
        (!validId(value.pendingOwnerOperation.sessionId) ||
          !validId(value.pendingOwnerOperation.instanceId) ||
          typeof value.pendingOwnerOperation.operationId !== "string" ||
          !/^[1-9][0-9]{0,15}:[a-f0-9-]{36}$/.test(
            value.pendingOwnerOperation.operationId,
          ) ||
          !["send", "half-close"].includes(
            value.pendingOwnerOperation.kind,
          ))) ||
      typeof value.sessionIdKnown !== "boolean" ||
      typeof value.uncertainStart !== "boolean" ||
      [value.uncertainSessions, value.persistenceProblems].some(
        (xs) =>
          !Array.isArray(xs) ||
          xs.length > 100 ||
          xs.some((x) => !validId(x) || !x),
      )
    )
      throw Error("无效恢复记录");
    for (const key of [
      "definitionId",
      "sessionId",
      "sessionIdKnown",
      "uncertainStart",
      "uncertainSessions",
      "persistenceProblems",
    ])
      state[key] = value[key];
    state.startRecoveryId = value.startRecoveryId || "";
    state.creationIntentId = value.creationIntentId || "";
    state.creationInstanceId = value.creationInstanceId || "";
    state.pendingOwnerOperation = value.pendingOwnerOperation || null;
    state.notice = "已恢复操作标记；请显式读取会话核对，不会自动连接或重发。";
  } catch {
    state.uncertainStart = true;
    state.notice =
      "无法读取恢复标记，新连接已阻止；请核对原会话，不会自动重试。";
  }
}
function syncGrpcStreamWorkbench() {
  if (grpcStreamOwner !== project || (grpcStreamVisible && page !== "grpc")) {
    if (grpcStreamState) invalidateGrpcStream(grpcStreamState);
    grpcStreamGeneration++;
  }
  if (grpcStreamProject !== project?.id) {
    grpcStreamProject = project?.id || "";
    grpcStreamState = grpcStreamProjectStates.get(grpcStreamProject);
    if (!grpcStreamState) {
      grpcStreamState = createGrpcStreamState();
      restoreGrpcStreamEvidence(grpcStreamProject, grpcStreamState);
      grpcStreamProjectStates.set(grpcStreamProject, grpcStreamState);
    }
  }
  grpcStreamOwner = project;
  grpcStreamVisible = page === "grpc";
}
function bindGrpcStreamWorkbench() {
  const root = $("#grpc-stream-workbench");
  if (!root) return;
  const state = grpcStreamState,
    owner = project,
    version = editVersion,
    generation = grpcStreamGeneration;
  const current = () => {
    if (
      project !== owner ||
      editVersion !== version ||
      page !== "grpc" ||
      grpcStreamState !== state ||
      grpcStreamGeneration !== generation
    )
      throw Error("项目或面板已变化，未应用迟到结果");
  };
  bindGrpcStream(root, {
    creationIntents: true,
    ownerOperationReceipts: true,
    state,
    definitions: owner.settings?.grpcDefinitions || [],
    assertCurrent: current,
    persistEvidence: (value) => persistGrpcStreamEvidence(owner.id, value),
    onChange: () => {
      if (
        page === "grpc" &&
        grpcStreamState === state &&
        grpcStreamGeneration === generation
      )
        render();
    },
    setBusy: (value, kind) => {
      if (value) {
        current();
        if (busy || saving) throw Error("请等待当前操作或保存结束");
        if (!["refresh", "cancel", "reconcile"].includes(kind)) {
          nativeRequestLifecycle.assertCanSave(owner.id);
          projectImports.assertCanSave(owner.id);
          if (dirty) throw Error("项目有未保存修改，请先保存；未自动保存");
        }
        grpcStreamBusyToken = { state };
        busy = true;
      } else if (
        grpcStreamBusyToken?.state === state &&
        !state.pending &&
        !state.cancelPending
      ) {
        grpcStreamBusyToken = null;
        busy = false;
      }
    },
    inspectDefinition: (definition) => {
      current();
      const source = Object.fromEntries(
        ["proto", "protoName", "files", "schema"]
          .filter((k) => definition[k] !== undefined)
          .map((k) => [k, structuredClone(definition[k])]),
      );
      return api("/projects/" + owner.id + "/grpc-schema", "POST", source);
    },
    get: (action) => {
      current();
      if (
        !/^(?:grpc-sessions\/[A-Za-z0-9_-]+|grpc-creation-intents\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)$/.test(
          action,
        )
      )
        throw Error("未知gRPC会话读取");
      return api("/projects/" + owner.id + "/" + action);
    },
    post: async (action, body) => {
      current();
      if (action === "grpc-creation-intents")
        return api("/projects/" + owner.id + "/" + action, "POST", body);
      if (
        !/^grpc-sessions(?:\/[A-Za-z0-9_-]+\/(?:send|half-close|cancel|reconcile))?$/.test(
          action,
        )
      )
        throw Error("未知gRPC会话操作");
      const recovery = /\/(cancel|reconcile)$/.test(action),
        shared = recovery ? grpcStreamOperations.get(owner.id) : null;
      const operation =
        shared ||
        (recovery
          ? projectImports.beginRecovery(owner.id)
          : projectImports.begin(owner.id, "execution"));
      if (!recovery) grpcStreamOperations.set(owner.id, operation);
      try {
        const result = await api(
          "/projects/" + owner.id + "/" + action,
          "POST",
          body,
        );
        if (["failed", "unknown"].includes(result?.receiptState))
          operation.requireReconciliation();
        return result;
      } catch (error) {
        operation.requireReconciliation();
        throw error;
      } finally {
        if (!shared) {
          operation.finish();
          if (grpcStreamOperations.get(owner.id) === operation)
            grpcStreamOperations.delete(owner.id);
        }
      }
    },
  });
}

const methodOptions = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];
const env = () => {
  const selected = $("#env")?.value || project?.currentEnvironmentId;
  return project?.environments.some((e) => e.id === selected)
    ? selected
    : project?.environments[0]?.id;
};
async function api(path, method = "GET", data) {
  const r = await fetch("/api" + path, {
    method,
    headers: { "content-type": "application/json", "x-local-token": token },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const b = await r.json();
  if (!r.ok) {
    const error = Error(b.error || r.statusText);
    error.projectCommitOutcome = {
      project_id: b.project_id,
      commit_outcome: b.commit_outcome,
      retry_safe: b.retry_safe,
    };
    throw error;
  }
  return b;
}
function toast(s) {
  $("#toast").textContent = s;
  $("#toast").style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").style.display = "none"), 3500);
}
function request() {
  return project?.requests.find((r) => r.id === current);
}
function workspaceDocument() {
  return page === "apis"
    ? workspaceDocumentById(project, activeDocumentId)
    : null;
}
function openWorkspaceDocument(id) {
  collect();
  if (!workspaceDocumentById(project, id))
    throw Error("文档标识不存在或重复，请从文档总览查看");
  if (!openedDocuments.includes(id)) openedDocuments.push(id);
  activeDocumentId = id;
  page = "apis";
  render();
}
function defaultRequest(name = "新建接口") {
  return {
    id: uid(),
    name,
    folder: "",
    method: "GET",
    url: "{{baseUrl}}",
    query: [],
    path: [],
    headers: [],
    cookies: [],
    auth: { type: "none" },
    bodyType: "none",
    body: "",
    form: [],
    assertions: [],
    extract: [],
    before: [],
    after: [],
    examples: [],
    schema: {},
    description: "",
    timeout: 15000,
  };
}
function mark() {
  editVersion++;
  dirty = true;
  $("#save")?.classList.add("primary");
  $("#save-project")?.classList.add("primary");
  const s = $("#saved-state");
  if (s) s.textContent = "● 未保存";
}
async function save() {
  if (project) nativeRequestLifecycle.assertCanSave(project.id);
  if (project) projectImports.assertCanSave(project.id);
  if (!project) return;
  if (saving) throw Error("保存尚未完成，请等待");
  collect();
  const owner = project,
    snapshot = structuredClone(project),
    version = editVersion,
    operation = projectImports.beginSave(project.id);
  snapshot.history = [];
  snapshot.runs = [];
  saving = true;
  for (const button of document.querySelectorAll("#save,#save-project"))
    button.disabled = true;
  try {
    const saved = await api("/projects/" + snapshot.id, "PUT", snapshot);
    assertProjectSaveReceipt(saved, snapshot);
    const metadata = projects.find((item) => item.id === saved.id);
    if (metadata)
      Object.assign(metadata, {
        name: saved.name,
        archived: !!saved.archived,
        updatedAt: saved.updatedAt,
      });
    if (project === owner) {
      if (editVersion === version) {
        const previousRequests = new Map(owner.requests.map((r) => [r.id, r]));
        for (const savedRequest of saved.requests) {
          const previous = previousRequests.get(savedRequest.id);
          const drafts = debugAuthDrafts.get(previous);
          if (
            drafts &&
            JSON.stringify(savedRequest.auth) === JSON.stringify(previous.auth)
          )
            debugAuthDrafts.set(savedRequest, drafts);
        }
        project = saved;
        dirty = false;
      } else {
        project.revision = saved.revision;
        project.configRevision = saved.configRevision;
        project._diskFingerprint = saved._diskFingerprint;
        project.history = saved.history;
        project.runs = saved.runs;
      }
    }
    toast(dirty ? "已保存本次快照，后续修改仍未保存" : "已保存到本地");
  } catch (error) {
    const outcome = error?.projectCommitOutcome;
    const rejected =
      outcome?.project_id === snapshot.id &&
      outcome.commit_outcome === "not_committed" &&
      outcome.retry_safe === false;
    if (rejected) {
      error.projectSaveRollback = { owner, version };
      throw error;
    }
    operation.requireReconciliation();
    throw Error(
      "保存结果尚未确认；不会自动重试。请重新加载原项目核对，当前草稿仍保留，请先复制需要保留的修改。",
      { cause: error },
    );
  } finally {
    operation.finish();
    saving = false;
    render();
  }
}

function assertProjectSaveReceipt(saved, snapshot) {
  const object = (value) =>
    value && typeof value === "object" && !Array.isArray(value);
  const fail = () => {
    throw Error("保存回执不完整或版本不匹配");
  };
  if (
    !object(saved) ||
    saved.id !== snapshot.id ||
    !Number.isSafeInteger(saved.revision) ||
    saved.revision <= (snapshot.revision ?? 0) ||
    !Number.isSafeInteger(saved.configRevision) ||
    saved.configRevision > saved.revision ||
    saved.configRevision !==
      (snapshot.configRevision ?? snapshot.revision ?? 0) + 1 ||
    typeof saved._diskFingerprint !== "string" ||
    !saved._diskFingerprint ||
    typeof saved.name !== "string" ||
    typeof saved.updatedAt !== "string" ||
    !object(saved.settings)
  )
    fail();
  for (const key of [
    "requests",
    "documents",
    "dictionary",
    "environments",
    "plans",
    "cases",
    "history",
    "runs",
  ])
    if (!Array.isArray(saved[key])) fail();
  // Only these internal histories are intentionally omitted by the owner response.
  const omitted = new Set(["requestDefinitionHistory", "loadRuns"]);
  for (const [key, value] of Object.entries(
    JSON.parse(JSON.stringify(snapshot)),
  )) {
    if (omitted.has(key)) continue;
    if (
      !Object.hasOwn(saved, key) ||
      (Array.isArray(value) && !Array.isArray(saved[key])) ||
      (object(value) && !object(saved[key]))
    )
      fail();
  }
}

function rollbackProjectSave(error, rollback) {
  const receipt = error?.projectSaveRollback;
  if (receipt?.owner !== project || receipt?.version !== editVersion)
    return false;
  rollback();
  mark();
  render();
  return true;
}

function collect() {
  const r = request();
  if (!r || page !== "apis" || workspaceDocument()) return;
  for (const [selector, key] of [
    ["#request-name", "name"],
    ["#url", "url"],
    ["#method", "method"],
    ["#body-code", "body"],
    ["#description", "description"],
  ]) {
    if ($(selector)) r[key] = $(selector).value;
  }
  const bodySelection = $('input[name="body-type"]:checked');
  if (bodySelection)
    r.bodyType =
      bodySelection.value === "raw"
        ? $("#raw-format")?.value || "raw"
        : bodySelection.value;
  if ($("#request-service")) r.serviceId = $("#request-service").value;
  if ($("#response-definitions")) {
    try {
      r.responses = JSON.parse($("#response-definitions").value);
      if (!Array.isArray(r.responses)) throw Error("必须为数组");
    } catch {
      throw Error("响应定义必须是有效JSON数组");
    }
  }
  if ($("#schema")) {
    try {
      r.schema = JSON.parse($("#schema").value);
    } catch {
      throw Error("JSON Schema 格式无效，请修正后再保存或切换");
    }
  }
}
async function changeNativeRequestLifecycle(requestId, restore) {
  projectImports.assertCanStart(project.id, "interfaces");
  return nativeRequestLifecycle.run({
    requestId,
    restore,
    getState: () => ({ project, dirty, editVersion, busy, saving }),
    collect,
    confirm,
    save,
    post: api,
    apply: (saved) => {
      project = saved;
      dirty = false;
      if (!project.requests.some((r) => r.id === current && !r.deletedAt))
        current = project.requests.find((r) => !r.deletedAt)?.id;
      response = responses.get(project.id + ":" + current) || null;
      render();
      toast(restore ? "接口已恢复" : "接口已移到回收站");
    },
  });
}
async function openProject(id) {
  if (
    socketioWorkbenchState?.draftDirty &&
    socketioWorkbenchProject === project?.id &&
    !confirm(
      "Socket.IO定义编辑尚未保存，重新加载或切换项目会丢弃此草稿，确定继续？",
    )
  )
    return false;
  if (
    grpcWorkbenchState?.draftDirty &&
    grpcWorkbenchProject === project?.id &&
    !confirm("gRPC定义编辑尚未保存，重新加载或切换项目会丢弃此草稿，确定继续？")
  )
    return false;
  if (busy || saving) throw Error("请先结束当前请求或保存，再切换项目");
  if (dirty && !confirm("当前修改尚未保存，确定切换项目？")) return;
  const reloadCheckpoint = nativeRequestLifecycle.reloadCheckpoint();
  const importCheckpoint = projectImports.reloadCheckpoint();
  const sequence = ++projectOpenSequence,
    previousProject = project,
    version = editVersion,
    previousDirty = dirty;
  const loaded = await api("/projects/" + id);
  if (sequence !== projectOpenSequence) return false;
  if (
    project !== previousProject ||
    editVersion !== version ||
    dirty !== previousDirty ||
    busy ||
    saving
  )
    throw Error("加载期间项目或草稿已变化，未替换当前内容；请重新操作");
  if (loaded?.id !== id) throw Error("返回项目身份不匹配，未替换当前内容");
  nativeRequestLifecycle.assertReloadCurrent(reloadCheckpoint);
  projectImports.assertReloadCurrent(importCheckpoint);
  if (grpcWorkbenchState) invalidateGrpcUnary(grpcWorkbenchState);
  grpcWorkbenchState = null;
  grpcWorkbenchProject = "";
  grpcNavigationGeneration++;
  if (socketioWorkbenchState) {
    invalidateSocketIO(socketioWorkbenchState);
    // Preserve in-memory uncertainty across reload; only discard the confirmed definition draft.
    selectSocketIO(
      socketioWorkbenchState,
      (loaded.id === project?.id
        ? loaded
        : project
      ).settings?.socketioDefinitions?.find(
        (item) => item.id === socketioWorkbenchState.selectedId,
      ),
    );
  }
  socketioNavigationGeneration++;
  project = loaded;
  nativeRequestLifecycle.acknowledgeReload(id, reloadCheckpoint);
  projectImports.acknowledgeReload(id, importCheckpoint);
  current = project.requests.find((r) => !r.deletedAt)?.id;
  opened = current ? [current] : [];
  openedDocuments = [];
  activeDocumentId = null;
  documentModes.clear();
  dirty = false;
  response = null;
  lastRun = null;
  loadResult = null;
  planId = "";
  selectedProtocolId = "";
  sessionStorage.setItem("project", id);
  render();
}
// A preview is read-only; its result may write only the draft and dialog that
// requested it. Rebind only when synchronously advancing to confirmation.
function previewDraftOwner() {
  collect();
  const owner = project,
    version = editVersion;
  let dialogVersion;
  return {
    owner,
    bindDialog() {
      dialogVersion = modalRevision;
    },
    assertCurrent() {
      if (
        project !== owner ||
        editVersion !== version ||
        modalRevision !== dialogVersion ||
        !$("#dialog").open
      )
        throw Error("项目、草稿或导入窗口已变化，请重新预览；未写入任何内容");
      if (busy || saving) throw Error("请先结束当前请求或保存，再导入");
      nativeRequestLifecycle.assertCanSave(owner.id);
      projectImports.assertCanSave(owner.id);
    },
  };
}
function openScopedDefinitionExport() {
  const context = previewDraftOwner();
  const resources = scopedExportResources(context.owner);
  const assertCurrent = () => {
    context.assertCurrent();
    if (dirty)
      throw Error("当前有未保存修改；未自动保存或导出，请先保存后重新打开");
  };
  modal(
    "选择定义导出（不是完整备份）",
    scopedExportSelectionHTML(resources),
    async () => {
      assertCurrent();
      const input = readScopedExportInput($("#dialog-content"), resources);
      const fingerprint = JSON.stringify(input);
      const preview = await api(
        "/projects/" + context.owner.id + "/export-preview",
        "POST",
        input,
      );
      assertCurrent();
      if (
        JSON.stringify(
          readScopedExportInput($("#dialog-content"), resources),
        ) !== fingerprint
      )
        throw Error("选择或格式已变化，请重新预览；未触发下载");
      assertScopedExportPreview(preview, input, context.owner);
      let attempted = false;
      modal(
        "确认导出范围与依赖",
        scopedExportConfirmationHTML(preview, resources),
        async () => {
          assertCurrent();
          if (!$("#scoped-export-accept").checked)
            throw Error("请先明确接受范围、依赖及敏感信息警告");
          if (attempted)
            throw Error(
              "本次下载结果尚未确认，请关闭后重新预览；不会自动重复下载",
            );
          attempted = true;
          const result = await api(
            "/projects/" + context.owner.id + "/export-selection",
            "POST",
            scopedExportRequest(input, preview),
          );
          assertCurrent();
          if (!$("#scoped-export-accept").checked)
            throw Error("已撤回确认；未触发下载，请重新预览");
          const document = assertScopedExportResult(result, preview);
          download(
            context.owner.name + ".selected." + input.format + ".json",
            document,
          );
        },
        "下载所选定义",
      );
      context.bindDialog();
    },
    "预览范围",
  );
  context.bindDialog();
}
function modal(title, html, onSave, label = "确定", afterClose) {
  const d = $("#dialog"),
    revision = ++modalRevision;
  let submitting = false;
  modalFocusHandlers?.abort();
  modalFocusHandlers = undefined;
  let handlers;
  const closeThisModal = (returnValue) => {
    if (modalRevision !== revision || !d.open) return;
    handlers?.abort();
    if (returnValue === undefined) d.close();
    else d.close(returnValue);
    if (modalRevision === revision && !d.open) afterClose?.();
  };
  if (afterClose) {
    // Native "close" is queued and can belong to the previous invocation of
    // this shared element. Deliver focus only from this invocation's close.
    handlers = modalFocusHandlers = new AbortController();
    const options = { signal: handlers.signal };
    d.addEventListener(
      "cancel",
      (event) => {
        event.preventDefault();
        closeThisModal();
      },
      options,
    );
    d.querySelector(":scope > form").addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        closeThisModal(event.submitter?.value);
      },
      options,
    );
  }
  $("#dialog-save").disabled = false;
  $("#dialog-title").textContent = title;
  $("#dialog-content").innerHTML = html;
  for (const button of $("#dialog-content").querySelectorAll("button"))
    button.type = "button";
  $("#dialog-save").textContent = label;
  $("#dialog-save").onclick = async () => {
    if (submitting) return;
    submitting = true;
    $("#dialog-save").disabled = true;
    try {
      await onSave();
      closeThisModal();
    } catch (e) {
      if (modalRevision === revision) toast(e.message);
    } finally {
      submitting = false;
      if (modalRevision === revision) $("#dialog-save").disabled = false;
    }
  };
  d.showModal();
  if ($("#pick-directory"))
    $("#pick-directory").onclick = async () => {
      if (!window.desktop?.chooseDirectory) {
        toast("浏览器模式请直接填写绝对路径；桌面版支持选择文件夹");
        return;
      }
      const directory = await window.desktop.chooseDirectory();
      if (directory) $("#new-directory").value = directory;
    };
  $("#dialog-content input")?.focus();
}
const jsonEditor = (value, id = "modal-json") =>
  `<textarea id="${id}" spellcheck="false">${esc(JSON.stringify(value, null, 2))}</textarea>`;
function nav() {
  return [
    ["history", "◷", "最近"],
    ["apis", "▤", "APIs"],
    ["docs", "▧", "文档"],
    ["dictionary", "♧", "字典"],
    ["settings", "⚙", "配置"],
    ["git", "⑂", "Git"],
    ["grpc", "↗", "gRPC"],
    ["socketio", "↗", "Socket.IO"],
  ]
    .map(
      ([key, icon, title]) =>
        `<button data-page="${key}" class="${page === key ? "active" : ""}" ${page === key ? 'aria-current="page"' : ""} title="${title}"><span class="icon">${lineIcon(icon)}</span>${title}</button>`,
    )
    .join("");
}
function tree() {
  return renderWorkspaceTree({
    project,
    search,
    searchType,
    page,
    current,
    activeDocumentId: workspaceDocument()?.id,
    selectedProtocolId,
    collapsedFolders,
  });
}

function render(preserveEditingFocus = false) {
  syncGrpcWorkbench();
  syncSocketIOWorkbench();
  syncGrpcStreamWorkbench();
  const active = document.activeElement;
  const responseTabsPosition = readResponseTabsPosition(
    $(".response-tabs"),
    active,
  );
  const parameterStrip = $(".param-tabs");
  const oldParameterScroll = parameterStrip?.scrollLeft || 0;
  const oldParameterFocus =
    active?.closest(".param-tabs") && active.dataset.param;
  const oldParameterSelection =
    parameterStrip?.querySelector(".active")?.dataset.param;
  const oldTabs = $(".tab-scroll");
  const oldTabScroll = oldTabs?.scrollLeft || 0;
  const tabIdentity = (button) =>
    button?.dataset.openDocumentTab !== undefined
      ? "doc:" + button.dataset.openDocumentTab
      : button?.dataset.openTab !== undefined
        ? "http:" + button.dataset.openTab
        : null;
  const oldSelectedTab = tabIdentity(
    oldTabs?.querySelector(".selected .tab-switch"),
  );
  const editing =
    preserveEditingFocus &&
    active &&
    active.matches(
      'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea',
    ) &&
    active.closest("#app");
  const focusKey =
    editing &&
    (active.id
      ? { id: active.id }
      : Object.entries(active.dataset).find(
          ([key]) => !key.startsWith("playwright"),
        ));
  const focusState = focusKey
    ? {
        value: active.value,
        start: active.selectionStart,
        end: active.selectionEnd,
        direction: active.selectionDirection,
        scrollTop: active.scrollTop,
        scrollLeft: active.scrollLeft,
      }
    : null;
  const r = request();
  const doc = workspaceDocument();
  document.body.classList.toggle("compact-ui", compactUI);
  $("#app").innerHTML =
    `<header class="top"><div class="top-group"><div class="brand"><span class="logo">↗</span>Local API <span class="subtle">单机版</span></div><button id="new-project" ${busy || saving ? "disabled" : ""} class="ghost">＋ 新建/导入项目</button></div><div class="top-group project-group"><select id="project-select" ${busy || saving ? "disabled" : ""} aria-label="项目">${projects
      .filter((p) => !p.archived && !p.error)
      .map(
        (p) =>
          `<option value="${p.id}" ${p.id === project?.id ? "selected" : ""}>${esc(p.name)}</option>`,
      )
      .join(
        "",
      )}</select><button id="open-location" class="ghost">打开位置</button><button id="save-project" ${saving ? "disabled" : ""} class="${dirty ? "primary" : "ghost"}">保存项目</button></div><div class="top-group top-actions"><button data-page="plans" class="ghost top-plan ${page === "plans" ? "active" : ""}"><span class="icon">${lineIcon("plan-play")}</span>执行计划</button><button id="mcp-status" data-page="settings" data-settings-target="settings-mcp" class="offline" title="打开 MCP 连接设置">MCP · ${mcpState.enabled ? "已开启" : "未开启"}</button><button id="theme" class="ghost" aria-label="切换主题">◐</button></div></header><div class="shell"><nav class="rail" aria-label="工作区导航">${nav()}<button data-page="trash" class="bottom ${page === "trash" ? "active" : ""}" ${page === "trash" ? 'aria-current="page"' : ""}><span class="icon">${lineIcon("♲")}</span>回收站</button></nav><aside class="sidebar" data-sidebar-page="${page}">${
      page === "settings"
        ? settingsSidebar(settingsSection)
        : `<div class="search"><div class="search-filter"><input id="search" placeholder="⌕ 关键字 / URL" aria-label="搜索接口" value="${esc(search)}"><select id="tree-type" aria-label="内容类型">${[
            ["all", "全部"],
            ["http", "HTTP"],
            ["sse", "SSE"],
            ["websocket", "WebSocket"],
            ["tcp", "TCP"],
            ["grpc", "gRPC"],
            ["socketio", "Socket.IO"],
            ["document", "文档"],
          ]
            .map(
              ([value, label]) =>
                `<option value="${value}" ${value === searchType ? "selected" : ""}>${label}</option>`,
            )
            .join(
              "",
            )}</select></div><button id="add-request" class="primary" aria-label="新建接口">＋</button></div><div class="section-label"><span>全部接口</span><div><button id="locate-request" class="ghost" title="${doc ? "定位当前文档" : "定位当前接口"}" aria-label="${doc ? "定位当前文档" : "定位当前接口"}">定位</button><button id="import" class="ghost" title="导入" aria-label="导入项目">导入</button><button id="export" class="ghost" title="导出项目" aria-label="导出项目">导出</button></div></div><div id="tree">${tree()}</div><details class="tree-create"><summary class="new-item">＋ 新建</summary><div><button id="new-request">HTTP 接口</button><button data-page="protocols">SSE / WebSocket / TCP</button><button data-page="grpc">gRPC unary</button><button data-page="socketio">Socket.IO</button><button id="new-folder">新建目录</button></div></details>`
    }</aside><main class="workspace">${
      page === "apis"
        ? `<div class="tabs"><div class="tab-scroll">${opened
            .filter((id) =>
              project.requests.some((r) => r.id === id && !r.deletedAt),
            )
            .map((id) => {
              const item = project.requests.find((r) => r.id === id);
              return `<div class="tab ${!doc && current === id ? "selected" : ""}"><button class="ghost tab-switch" data-open-tab="${id}"><span class="method ${item.method}">${item.method}</span> <span data-tab-name="${id}">${esc(item.name)}</span></button><button class="ghost tab-close" data-close-tab="${id}" aria-label="关闭 ${esc(item.name)}">×</button></div>`;
            })
            .join(
              "",
            )}${documentWorkspaceTabs(project, openedDocuments, doc?.id)}<button id="tab-add" class="ghost" aria-label="新建接口标签页">＋</button></div><div class="tools"><select id="env" aria-label="执行环境">${project?.environments.map((e) => `<option value="${e.id}" ${e.id === env() ? "selected" : ""}>${esc(e.name)}</option>`).join("") || ""}</select><button id="open-environment-settings" type="button" class="ghost" title="环境设置" aria-label="环境设置" aria-haspopup="dialog">☷</button></div></div>${doc ? workspaceDocumentHTML(doc, { editing: documentModes.get(doc.id)?.view === "edit", saving, synchronized: documentModes.get(doc.id)?.synchronized !== false, status: (project.settings?.statuses || []).find((item) => item.id === doc.statusId)?.name }) : r ? editor(r) : '<div class="empty"><span class="empty-symbol">↗</span><p>从一个请求开始</p><small>创建或导入接口，所有数据只留在本机。</small><button id="welcome-add" class="primary">＋ 新建接口</button></div>'}`
        : renderPage()
    }</main></div><footer class="statusbar"><span>◈ 本地工作空间 &nbsp; / &nbsp; ${esc(project?.name || "")} &nbsp; <span id="saved-state">${dirty ? "● 未保存" : "✓ 已保存"}</span></span><span class="status-actions"><button id="compact-ui" aria-pressed="${compactUI}" title="隐藏项目树，保留导航和工作区">${compactUI ? "完整模式" : "精简模式"}</button><button id="response-layout" ${page !== "apis" || doc || mode !== "debug" ? "disabled" : ""} aria-pressed="${responseLayout === "split"}">${responseLayout === "split" ? "上下布局" : "左右布局"}</button><span>Local API 0.1.0</span></span></footer>`;
  bind();
  const tabScroll = $(".tab-scroll");
  if (tabScroll) {
    tabScroll.scrollLeft = oldTabScroll;
    const selectedTab = tabScroll.querySelector(".selected .tab-switch");
    if (selectedTab && tabIdentity(selectedTab) !== oldSelectedTab)
      selectedTab.parentElement.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
  }
  restoreResponseTabsPosition($(".response-tabs"), responseTabsPosition);
  const nextParameterStrip = $(".param-tabs");
  if (nextParameterStrip) {
    nextParameterStrip.scrollLeft = oldParameterScroll;
    const restored =
      oldParameterFocus &&
      [...nextParameterStrip.querySelectorAll("[data-param]")].find(
        (item) => item.dataset.param === oldParameterFocus,
      );
    const selected = nextParameterStrip.querySelector(".active");
    if (restored) {
      restored.focus({ preventScroll: true });
      revealParameterTab(nextParameterStrip, restored);
    } else if (selected && selected.dataset.param !== oldParameterSelection) {
      revealParameterTab(nextParameterStrip, selected);
    }
  }
  if (focusState) {
    const replacement = focusKey.id
      ? document.getElementById(focusKey.id)
      : [...document.querySelectorAll("#app input, #app textarea")].find(
          (node) => node.dataset[focusKey[0]] === focusKey[1],
        );
    if (
      replacement &&
      replacement.tagName === active.tagName &&
      replacement.type === active.type &&
      !replacement.disabled
    ) {
      replacement.value = focusState.value;
      replacement.focus({ preventScroll: true });
      if (focusState.start !== null && focusState.end !== null)
        replacement.setSelectionRange(
          focusState.start,
          focusState.end,
          focusState.direction,
        );
      replacement.scrollTop = focusState.scrollTop;
      replacement.scrollLeft = focusState.scrollLeft;
    }
  }
}
function editor(r) {
  return `<section data-editor-mode="${esc(mode)}" class="editor ${mode === "debug" && responseLayout === "split" ? "split-layout" : ""}"><div class="subnav"><div class="request-modes" role="group" aria-label="接口工作模式">${[
    ["design", "设计"],
    ["debug", "调试"],
    ["cases", "接口用例"],
    ["load", "一键压测"],
    ["mock", "Mock"],
  ]
    .map(
      ([key, label]) =>
        `<button data-mode="${key}" class="${mode === key ? "active" : ""}" aria-pressed="${mode === key}">${label}</button>`,
    )
    .join(
      "",
    )}</div><select id="request-status" aria-label="接口状态"><option value="">未设置状态</option>${(project.settings?.statuses || []).map((status) => `<option value="${esc(status.id)}" ${r.statusId === status.id ? "selected" : ""}>${esc(status.name)}</option>`).join("")}</select><input id="request-name" class="request-name" aria-label="接口名称" value="${esc(r.name)}"><button id="share-api">分享</button>${requestCurlAction(mode === "debug")}<button id="duplicate" title="复制接口">⧉</button><button id="delete" title="删除接口" class="danger">×</button></div><div class="urlbar"><div class="url-input"><select id="method" aria-label="请求方法">${methodOptions.map((m) => `<option ${r.method === m ? "selected" : ""}>${m}</option>`).join("")}</select><input id="url" aria-label="请求 URL" placeholder="输入请求地址，支持 {{变量}}" value="${esc(r.url)}"><select id="http-version" aria-label="HTTP协议版本"><option value="1.1" ${r.httpVersion !== "2" ? "selected" : ""}>http/1.1</option><option value="2" ${r.httpVersion === "2" ? "selected" : ""}>http/2</option></select></div>${mode === "design" ? `<button id="request-design-preview">预 览</button><button id="save" class="primary">保 存</button>${busy && !caseCancellationOwner() ? '<button id="cancel">取消</button>' : ""}` : httpRequestActions({ debug: mode === "debug", busy, cancel: busy && mode !== "cases" && !caseCancellationOwner(), dirty })}</div>${
    mode === "debug"
      ? `${requestParameterTabs(r, param)}<div class="request-panel ${["headers", "query", "path", "cookies"].includes(param) ? "request-pairs-panel" : ""} ${bodyExpanded && param === "body" ? "body-expanded" : ""} ${param === "body" && !["none", "form-data", "urlencoded"].includes(r.bodyType) ? "body-panel" : ""}">${paramPanel(r, param)}</div><div class="response"><div class="response-top">${httpResponseTabs(responseTab, response?.subrequests?.length)}<div class="metrics">${response ? `<span class="${response.status < 400 ? "success" : "failed"}">${response.status || "ERROR"} ${esc(project.settings?.statusCodes?.find((item) => item.httpHint === true && String(item.code) === String(response.status))?.label || "")}</span><span>${response.duration ?? 0} ms</span><span>${response.size ?? 0} B</span>` : ""}</div></div><div class="response-body">${responseContent()}</div></div>`
      : modePanel(r)
  }</section>`;
}
function pairs(rows, key, designOptions, debugOptions) {
  const debugComposer = Boolean(debugOptions);
  const design = Boolean(designOptions);
  const metadataColumn = ["headers", "query", "path", "cookies"].includes(key);
  const queryEquality =
    key !== "query"
      ? ""
      : debugComposer
        ? debugQueryEquality(debugOptions.queryAddEqual)
        : design
          ? `<label class="design-query-equality" title="空值 Query 参数添加等号（仅参数表）"><input id="query-add-equal" type="checkbox" ${designOptions.queryAddEqual !== false ? "checked" : ""} aria-label="空值 Query 参数添加等号"><span aria-hidden="true">=</span></label>`
          : "";
  const valueHeading =
    debugComposer && key === "query"
      ? `<span class="debug-query-value-heading">${queryEquality}参数值</span>`
      : queryEquality + "参数值";
  if (debugComposer && !rows.length)
    return `<table class="pairs-table request-pairs-table debug-pairs-table debug-pairs-empty"><colgroup><col span="3"></colgroup><thead><tr><th scope="col" class="debug-pair-name-heading">参数名</th><th scope="col">${valueHeading}</th><th scope="col">描述</th></tr></thead><tbody>${debugPairComposer(key, true)}</tbody></table>`;
  const compactEmpty =
    design && (key === "headers" || key === "query") && !rows.length;
  return `<table class="pairs-table ${metadataColumn ? "request-pairs-table" : ""}${debugComposer ? " debug-pairs-table" : ""}"><thead><tr><th class="pair-enabled-heading" aria-label="启用"></th><th class="pair-name-heading">参数名</th><th>${valueHeading}</th>${metadataColumn ? '<th class="pair-description-heading">描述</th>' : ""}${compactEmpty ? "" : '<th class="pair-actions-heading">操作</th>'}</tr></thead><tbody>${compactEmpty ? `<tr><td colspan="4"><button type="button" class="ghost design-empty-pair" data-add-pair="${key}">＋ 添加参数</button></td></tr>` : ""}${rows
    .map((p, i) => {
      const selector =
        key === "form"
          ? `<select data-field-type="${i}" aria-label="字段类型"><option value="text" ${p.type !== "file" ? "selected" : ""}>文本</option><option value="file" ${p.type === "file" ? "selected" : ""}>文件</option></select>`
          : "";
      const value =
        p.type === "file"
          ? `<span class="pair-file"><input type="file" data-field-file="${i}"><small title="${esc(p.filename || "未选择文件")}">${esc(p.filename || "未选择文件")}</small></span>`
          : `<input data-pair="${key}:${i}:value" placeholder="参数值 / {{变量}}" value="${esc(p.value)}">`;
      return `<tr><td><input type="checkbox" data-pair-enabled="${key}:${i}" ${p.enabled !== false ? "checked" : ""} aria-label="启用参数"></td><td><input data-pair="${key}:${i}:key" placeholder="参数名" value="${esc(p.key)}"></td><td><div class="pair-value">${selector}${value}</div></td>${metadataColumn ? `<td class="pair-description" title="${esc(p.description || "")}">${esc(p.description || "")}</td>` : ""}<td><div class="pair-row-actions"><button data-dynamic-pair="${key}:${i}">${p.dynamic ? "动态✓" : "动态"}</button><button data-dictionary-pair="${key}:${i}">字典</button><button data-define-pair="${key}:${i}" title="参数类型、必填与说明">定义</button><button data-remove-pair="${key}:${i}" aria-label="删除参数">×</button></div></td></tr>`;
    })
    .join(
      "",
    )}${debugComposer ? debugPairComposer(key, false) : ""}</tbody></table>${compactEmpty || debugComposer ? "" : `<div class="pair-actions"><button data-add-pair="${key}">＋ 添加参数</button></div>`}`;
}
function paramPanel(r, param, design = false) {
  if (["headers", "query", "path", "cookies"].includes(param))
    return (
      (param === "headers"
        ? `<div class="header-common-parameters"><button type="button" class="ghost" data-page="settings" data-settings-target="settings-global-parameters" title="管理项目及目录公共请求参数">${lineIcon("⚙")}公共参数（Header）</button></div>`
        : "") +
      pairs(
        r[param],
        param,
        design ? { queryAddEqual: r.queryAddEqual } : null,
        !design && ownsDebugPairComposer(param, page, mode, param)
          ? { queryAddEqual: r.queryAddEqual }
          : null,
      ) +
      (param === "cookies"
        ? `<div class="cookie-toolbar"><div class="cookie-manager-row"><button id="cookie-manager">Cookie管理器</button><span class="muted">按项目与环境隔离，默认关闭</span></div><label class="cookie-encoding-field">参数表 Cookie 编码<select id="cookie-encoding">${[
            ["raw", "保持原值"],
            ["apipost", "名称和值：避免重复编码"],
            ["apipost-name", "仅名称：避免重复编码"],
          ]
            .map(
              ([value, label]) =>
                `<option value="${value}" ${(r.cookieEncoding || "raw") === value ? "selected" : ""}>${label}</option>`,
            )
            .join(
              "",
            )}</select></label></div><p class="muted">只作用于参数表，不重写显式 Cookie 请求头或 Cookie 管理器内容。</p>`
        : "")
    );
  if (param === "body") {
    const debugRawJSON = !design && r.bodyType === "json";
    const expandLabel = bodyExpanded ? "收起编辑器" : "展开编辑器";
    return `<div class="body-types">${["none", "form-data", "urlencoded", "binary", "msgpack", "raw"].map((type) => `<label><input type="radio" name="body-type" value="${type}" ${(r.bodyType === "json" ? "raw" : r.bodyType) === type ? "checked" : ""}>${!design && (r.bodyType === "none" || debugRawJSON) ? `<span class="body-type-caption" title="${type}">${type}</span>` : type}</label>`).join("")}${["json", "raw"].includes(r.bodyType) ? `<select id="raw-format" aria-label="Raw格式"><option value="json" ${r.bodyType === "json" ? "selected" : ""}>JSON</option><option value="raw" ${r.bodyType === "raw" ? "selected" : ""}>Text</option></select>` : ""}</div>${r.bodyType === "none" ? "" : `<div class="body-actions${debugRawJSON ? " http-debug-raw-actions" : ""}"><button id="generate-body" class="ghost">基于数据结构生成</button><span class="grow">${r.bodyType === "binary" ? "输入 Base64 编码的二进制数据" : "请求体 · 保存在本地"}</span><button id="format-json" class="ghost"${debugRawJSON ? ' aria-label="格式化 JSON"' : ""}>${debugRawJSON ? "美化" : "格式化 JSON"}</button>${design ? "" : `<button id="expand-body" class="ghost" ${["none", "form-data", "urlencoded"].includes(r.bodyType) ? "disabled" : ""} aria-pressed="${bodyExpanded}" title="展开编辑器，Esc 收起">${debugRawJSON ? `<span class="debug-raw-expand-icon">${lineIcon("editor-expand")}</span><span class="debug-raw-expand-label">${expandLabel}</span>` : expandLabel}</button>`}</div>`}${
      ["form-data", "urlencoded"].includes(r.bodyType)
        ? pairs(r.form, "form")
        : r.bodyType === "none"
          ? `<div class="body-none"><span class="body-none-icon">${lineIcon("body-empty")}</span><p>当前请求未包含 Body</p>${design ? "" : '<button id="generate-body" class="ghost">基于数据结构生成</button>'}</div>`
          : `<div class="body-editor-shell"><div class="code-editor"><pre id="code-gutter" aria-hidden="true">${r.body
              .split("\n")
              .map((_, i) => i + 1)
              .join(
                "\n",
              )}</pre><pre id="code-highlight" aria-hidden="true"${debugRawJSON ? ' class="debug-raw-json-highlight"' : ""}>${highlightJSON(r.body)}\n</pre><textarea id="body-code" class="code" wrap="off" spellcheck="false" aria-label="请求体"${debugRawJSON ? ' placeholder=" "' : ""}>${esc(r.body)}</textarea></div><button id="toggle-parameter-helper" class="helper-toggle" aria-label="参数助手" aria-expanded="${helperOpen}"><span class="helper-label" aria-hidden="true"><span>参</span><span>数</span><span>助</span><span>手</span></span></button>${
              helperOpen
                ? `<aside class="parameter-helper"><h4>动态值</h4><button id="new-body-dynamic">插入动态值</button>${Object.keys(
                    r.bodyDynamic || {},
                  )
                    .map(
                      (id) =>
                        `<button data-edit-body-dynamic="${esc(id)}">编辑 ${esc(id.slice(0, 8))}</button>`,
                    )
                    .join("")}<h4>插入环境变量</h4>${
                    Object.keys({
                      ...project.globalVariables,
                      ...project.environments.find((item) => item.id === env())
                        ?.variables,
                    })
                      .map(
                        (key) =>
                          `<button data-insert-variable="${esc(key)}">{{${esc(key)}}}</button>`,
                      )
                      .join("") || "<p>暂无变量</p>"
                  }<h4>内置动态变量</h4><select id="builtin-variable" aria-label="内置动态变量">${builtinVariableNames.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("")}</select><button id="insert-builtin-variable">插入占位符</button><small>每次发送生成；JSON字符串值须加引号。</small><h4>参数字典 · 插入 JSON 字段</h4>${
                    effectiveParameterDictionary(project)
                      .map(
                        (entry) =>
                          `<button data-insert-dictionary="${esc(entry.id)}" title="${esc(entry.description)}">${esc(entry.key)} · ${esc(entry.type)}</button>`,
                      )
                      .join("") || "<p>暂无字典参数</p>"
                  }<h4>共享函数</h4><p class="muted">供前后置脚本调用</p>${(project.settings?.functions || []).map((fn) => `<code>utils.${esc(fn.name)}(...)</code>`).join("<br>")}<h4>请求结构</h4><pre>${esc(JSON.stringify(r.schema, null, 2))}</pre></aside>`
                : ""
            }</div>`
    }`;
  }
  if (param === "auth")
    return !design && mode === "debug" && usesDebugAuthChoice(project, r)
      ? httpDebugAuthPane(r)
      : httpAuthPane(r.auth, r.inheritAuth);
  if (param === "assertions")
    return `<table><thead><tr><th>目标</th><th>操作</th><th>预期值（JSON 或文本）</th><th></th></tr></thead><tbody>${r.assertions.map((a, i) => `<tr><td><input data-rule="${i}:target" value="${esc(a.target)}" placeholder="status / $.data.id / duration"></td><td><select data-rule="${i}:op">${["eq", "neq", "contains", "exists", "lt", "gt"].map((op) => `<option ${a.op === op ? "selected" : ""}>${op}</option>`).join("")}</select></td><td><input data-rule="${i}:value" value="${esc(JSON.stringify(a.value))}"></td><td><button data-remove-rule="${i}">×</button></td></tr>`).join("")}</tbody></table><p><button id="add-assertion">＋ 添加断言</button> <button id="edit-operations">JSON 高级编辑</button></p><div class="notice">status 为状态码，duration 为毫秒，body 为原文；JSON 路径如 $.data.id；响应头使用 header:content-type。</div>`;
  if (param === "extract")
    return `<table><thead><tr><th>变量名</th><th>保存至</th><th>来源</th><th>路径 / 头名 / Cookie / 正则</th><th>捕获组</th><th></th></tr></thead><tbody>${r.extract
      .map(
        (a, i) =>
          `<tr><td><input data-extract="${i}:name" value="${esc(a.name)}"></td><td><select data-extract="${i}:scope">${[
            ["runtime", "运行时"],
            ["local", "本请求"],
            ["environment", "环境（保存）"],
            ["global", "全局（保存）"],
          ]
            .map(
              ([value, label]) =>
                `<option value="${value}" ${(a.scope || "runtime") === value ? "selected" : ""}>${label}</option>`,
            )
            .join("")}</select></td><td><select data-extract="${i}:source">${[
            ["json", "Response JSON"],
            ["header", "Response Header"],
            ["cookie", "Response Cookie"],
            ["duration", "响应时间 (ms)"],
            ["text", "完整响应文本"],
            ["regex", "文本正则"],
            ["xml", "XML / XPath"],
          ]
            .map(
              ([value, label]) =>
                `<option value="${value}" ${(a.source || "json") === value ? "selected" : ""}>${label}</option>`,
            )
            .join(
              "",
            )}</select></td><td><input data-extract="${i}:path" value="${esc(a.path)}" placeholder="$.data.token 或 /token=(.+)/"></td><td><input type="number" min="0" max="99" data-extract="${i}:group" value="${esc(a.group ?? 0)}" aria-label="正则捕获组"></td><td><button data-remove-extract="${i}">×</button></td></tr>`,
      )
      .join(
        "",
      )}</tbody></table><p><button id="add-extract">＋ 提取变量</button><button id="edit-operations">JSON 高级编辑</button></p><div class="notice">默认运行时变量可传递给后续步骤；本请求变量不跨请求。环境/全局目的层会保存到项目，同名并发变更报错。响应时间与完整文本不需要路径；正则在隔离 VM 执行，文本上限 256 KiB，捕获组 0 为完整匹配；XML/XPath 上限 1 MiB，禁止 DTD；索引从 1 开始，多节点取首个，可使用 /root/item[1]/text()。命名空间映射可在高级 JSON 中设置 namespaces。</div>`;
  if (param === "before" || param === "after")
    return `<div class="script-mode-controls"><label>脚本兼容模式<select id="script-dialect">${scriptDialectOptions(r.scriptDialect)}</select></label><label>URL脚本模式<select id="script-url-mode">${scriptURLModeOptions(r.scriptURLMode)}</select></label></div><p class="script-actions"><button id="expand-script" aria-haspopup="dialog">展开脚本编辑器</button> <button id="edit-operations">声明式操作（高级）</button> <button id="add-db-operation">添加数据库查询</button></p><textarea id="script-code" class="full-code" aria-label="接口脚本" spellcheck="false" placeholder="${param === "before" ? "apt.setVar('requestId', 'demo');" : "pm.test('status', () => pm.expect(pm.response.code).to.equal(200));"}">${esc(r[param + "Script"] || "")}</textarea><p class="muted">${scriptDialectNotice}</p><label class="notice"><input id="inherit-shared-scripts" type="checkbox" ${r.inheritSharedScripts !== false ? "checked" : ""}>调试继承项目/当前目录脚本；执行计划不自动继承。</label><details class="notice script-policy"><summary>JavaScript 沙箱 · 无文件访问 · 250ms计算 / 2s总截止</summary><p>JavaScript 在独立 QuickJS 沙箱中执行，无文件/Node或任意模块访问。支持Promise/await、有界定时器及pm.sendRequest(config[, callback]) HTTP子请求（最多10次/并发4次、总计仍限2秒），以及 apt.setVar/getVar、set/removeRequestQuery/Header/Body、pm.environment/pm.globals（持久化）、pm.variables（仅当前请求）、pm.response、pm.test/Chai断言、CryptoJS（含受限安全随机数）、lodash（_）、moment、uuid、JSON5（输入/输出各64KiB）、有界 csv2array(text) / xml2Json(text) 和 console.log；累计250ms脚本运行预算（墙钟时间，不含HTTP等待）、2秒worker总截止、16MiB VM 内存限制。前置 getFinalRequestRawBody() 支持至多64KiB的 raw/JSON正文及已有变量替换，写回后避免发送时重复替换；暂不支持表单和声明式动态正文。后置脚本可用 apt.visualizer.set(template, data) 生成隔离的静态表格/列表；数据库操作须单独授权会话连接。</p><p>表单支持 pm.request.body.update 和 urlencoded/formdata 集合；one/all/each 的文本项可赋值或 update。最多1000项，单值64KiB、文本合计256KiB；文件仅提供已选择的元数据，不接受路径或新增文件。后置 setBody/setCode 仅生成独立脚本视图，不改写网络证据。</p></details>${r[param]?.length ? `<details class="operation-summary" open><summary>${r[param].length} 条声明式操作（先于本阶段 JavaScript）</summary>${r[param].map((operation, index) => `<div class="operation-card" data-operation-index="${index}"><div class="row"><strong class="grow">${index + 1}. ${esc(operation.name || operation.type)} · ${operation.type === "database" ? "数据库只读" : esc(operation.type)}${operation.enabled === false && operation.type === "database" ? "（停用）" : ""}</strong>${operation.type === "database" ? `<button data-edit-db-operation="${index}">编辑 / 重新绑定</button><button data-toggle-db-operation="${index}" title="启停查询不会清除已有运行时变量">${operation.enabled === false ? "启用" : "停用"}</button>` : ""}<button data-move-operation="${index}:-1" ${index === 0 ? "disabled" : ""}>上移</button><button data-move-operation="${index}:1" ${index === r[param].length - 1 ? "disabled" : ""}>下移</button><button data-remove-operation="${index}">移除</button></div><pre>${esc(operation.type === "database" ? operation.sql : JSON.stringify(operation))}</pre></div>`).join("")}</details>` : ""}`;
  const descriptions = {
    assertions:
      "状态码 / JSON 路径 / 响应时间断言。支持 eq、neq、contains、exists、lt、gt。",
    extract: "从响应 JSON 提取变量，用于执行计划后续步骤。",
    before: "声明式操作：set、uuid、timestamp、delete。不会执行任意系统代码。",
    after: "响应后的声明式变量操作，执行记录可追溯。",
  };
  return `<div class="notice">${descriptions[param]}</div><pre>${esc(JSON.stringify(r[param], null, 2))}</pre><button id="edit-operations">编辑${param === "assertions" ? "断言" : param === "extract" ? "提取规则" : "操作"}</button>`;
}
function responseContent() {
  if (responseTab === "examples")
    return (
      request()
        .examples.map(
          (example) =>
            `<h4>${esc(example.name)} · ${esc(example.status)}</h4><pre>${esc(example.body)}</pre>`,
        )
        .join("") || '<div class="empty"><p>在 Mock 页添加响应示例</p></div>'
    );
  if (!response) {
    const data = !busy && unsentResponseData(responseTab);
    return (
      data ||
      `<div class="empty http-response-empty"><div class="empty-symbol">${lineIcon("rocket")}</div><p>输入 URL 后点击发送获取响应结果</p><small>Ctrl + Enter 发送请求 · Ctrl + S 保存接口</small></div>`
    );
  }
  if (responseTab === "scriptResponse") {
    if (!response.scriptResponse)
      return '<div class="notice">后置脚本可用 pm.response.setBody(value) / setCode(code) 创建处理视图；不改写原始网络证据。</div>';
    const view = response.scriptResponse;
    return `<div class="notice">脚本处理视图，不改写网络响应、预设断言或最终成功状态。Header、耗时和大小仍属于原始网络响应。</div><p>处理状态：${esc(view.status ?? response.status)} · 网络状态：${esc(response.status)}</p><pre id="response-script-view">${esc(view.body ?? response.body ?? "")}</pre>`;
  }
  if (responseTab === "visualization")
    return typeof response.visualization === "string"
      ? '<p class="muted">隔离静态预览：不执行脚本、不加载外部资源、不打开链接。可用 apt.visualizer.set(template, data)。</p><iframe id="response-visualization" title="响应可视化" sandbox="" referrerpolicy="no-referrer"></iframe>'
      : '<div class="notice">后置脚本调用 apt.visualizer.set(template, data) 后在此预览；支持 Handlebars 表格、列表；采用内置样式。</div>';
  if (responseTab === "assertions") {
    const assertions = response.assertions || [];
    const counts = assertionCounts(assertions);
    return `${response.error ? `<div class="notice failed">${esc(response.error)}</div>` : ""}<p class="assertion-counts">通过 ${counts.passed} · 失败 ${counts.failed} · 跳过 ${counts.skipped}（跳过项未执行，不计为通过）</p><pre>${esc(JSON.stringify(assertions, null, 2))}</pre>`;
  }
  let v =
    responseTab === "body"
      ? response.body
      : responseTab === "cookies"
        ? response.headers?.["set-cookie"] || []
        : response[responseTab];
  const failure = response.error
    ? `<div class="notice failed">${esc(response.error)}</div>`
    : "";
  if (responseTab === "body") {
    try {
      v = JSON.stringify(JSON.parse(v), null, 2);
    } catch {}
  }
  return `${failure}${response.rawBodyBase64 ? '<button id="download-response-binary">下载原始二进制响应</button>' : ""}${response.codecError ? `<div class="notice">解码失败，以下为 Base64：${esc(response.codecError)}</div>` : ""}<pre>${esc(typeof v === "string" ? v : JSON.stringify(v, null, 2))}</pre>`;
}
function designParameterPanel(r) {
  return `<div class="design-parameter-tabs" role="tablist" aria-label="设计请求参数标签">${designParameterTabs
    .map(([key, label]) => {
      const selected = key === designParameter;
      return `<button type="button" class="ghost" id="design-tab-${key}" role="tab" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" aria-controls="design-parameter-panel" data-design-parameter="${key}">${label}</button>`;
    })
    .join(
      "",
    )}</div><div id="design-parameter-panel" class="design-parameter-panel" role="tabpanel" aria-labelledby="design-tab-${designParameter}" tabindex="0">${paramPanel(r, designParameter, true)}</div>`;
}
function modePanel(r) {
  if (mode === "design") {
    const descriptionOpen =
      openDesignDescriptions.get(r) ?? Boolean(r.description);
    return `<div class="page http-design-canvas">${r.importNotes?.length ? `<div class="notice import-notes" role="region" aria-label="导入兼容性提示" tabindex="0">导入提示：${r.importNotes.map(esc).join("<br>")}</div>` : ""}${importedScriptTasksHTML(r.importedScriptTasks)}<div class="design-meta"><label for="folder">目录<input id="folder" value="${esc(r.folder)}" placeholder="根目录"></label><label for="request-service">绑定服务<select id="request-service"><option value="">完整 URL 直连 / 相对路径继承目录</option>${(project.servers || []).map((server) => `<option value="${server.id}" ${r.serviceId === server.id ? "selected" : ""}>${esc(server.name)}</option>`).join("")}</select></label></div>
    <section class="request-description-section" aria-label="详细说明"><h2><span>${lineIcon("▧")}</span>详细说明</h2><details id="design-description" ${descriptionOpen ? "open" : ""}><summary><span class="design-description-closed">＋ 添加详细说明</span><span class="design-description-open">收起</span></summary><div class="design-description-toolbar" role="group" aria-label="说明格式工具">${markdownTools.map(([key, glyph, label]) => `<button type="button" class="ghost" data-design-markdown="${key}" aria-label="${label}" title="${label}">${esc(glyph)}</button>`).join("")}</div><div class="design-description-editor"><textarea id="description" aria-label="接口详细说明" spellcheck="false">${esc(r.description)}</textarea><div id="design-description-preview" class="markdown-content" role="region" aria-label="说明预览">${descriptionOpen ? renderMarkdown(r.description) : ""}</div></div><small id="design-description-count">字数: ${Array.from(r.description || "").length}　行数: ${(r.description || "").split("\n").length}</small></details></section>
    <section class="design-request-parameters" aria-label="设计请求参数"><h2><span>${lineIcon("☷")}</span>设计请求参数</h2>${designParameterPanel(r)}</section>
    <section class="design-response-structure" aria-label="设计响应参数"><h2><span>${lineIcon("▤")}</span>设计响应参数</h2>${designResponsePanel(r.responses || [], designResponseSelections.get(designResponseKey(r)), r.openapiExampleBindingsVersion === 1, r.examples, collapsedDesignResponseRoots.get(r))}</section>
    <section class="design-request-structure" aria-label="请求数据结构"><h2><span>${lineIcon("☷")}</span>请求数据结构</h2><div><button id="visual-schema" type="button">可视化编辑结构</button>${designParameter === "body" && r.bodyType !== "none" ? "" : '<button id="generate-body" type="button" class="ghost">基于数据结构生成</button>'}<textarea id="schema" aria-label="请求 JSON Schema">${esc(JSON.stringify(r.schema, null, 2))}</textarea></div></section>
    <section class="design-advanced" aria-label="请求选项"><h2><span>${lineIcon("⚙")}</span>请求选项</h2><div class="form-grid"><label>全局请求参数</label><label><input id="inherit-global-parameters" type="checkbox" ${r.inheritGlobalParameters !== false ? "checked" : ""}>继承项目及目录 Header / Query / Cookie / 表单参数</label><label>超时（ms）</label><input id="timeout" type="number" min="100" max="60000" value="${r.timeout}"><label>HTTP/HTTPS 代理</label><input id="request-proxy" value="${esc(r.proxy)}" placeholder="http://127.0.0.1:8080"><label>自定义 CA（PEM）</label><textarea data-tls="ca">${esc(r.tls?.ca || "")}</textarea><label>HTTPS代理 CA（PEM，与目标站点CA分开）</label><textarea data-tls="proxyCa">${esc(r.tls?.proxyCa || "")}</textarea><label>客户端证书（PEM）</label><textarea data-tls="cert">${esc(r.tls?.cert || "")}</textarea><label>客户端私钥（PEM）</label><textarea data-tls="key">${esc(r.tls?.key || "")}</textarea><label>私钥口令</label><input data-tls="passphrase" type="password" value="${esc(r.tls?.passphrase || "")}">${attributeFields(project.settings?.attributes || [], r.attributes)}</div><div class="notice">TLS 校验始终开启，可粘贴自定义 CA。保存接口会将证书/私钥写入本地项目；导出前务必删除敏感凭据。执行计划保存独立快照。</div></div></section></div>`;
  }
  if (mode === "mock")
    return `<div class="page"><h2>本地 Mock 与响应示例</h2><button id="edit-mock-rules">编辑条件响应期望规则</button><button data-page="settings" data-settings-target="settings-mock-fields">配置智能字段 Mock</button><p class="muted">指定示例时直接返回该示例；否则按顺序匹配规则，不匹配时返回首个示例；没有示例时按 2xx JSON 响应 Schema 和项目字段规则生成。</p><p class="muted">Mock 地址只在本机应用运行时可用。切换调试会先保存当前改动；指定示例会停用请求中同名 example 参数，其他全局参数与脚本仍会执行。HTML 响应隔离展示，不运行页面脚本；禁止 Set-Cookie 等修改浏览器状态的头。</p><input class="mock-url" readonly value="${esc(mockURL(location.origin, project.id, r.id))}"><div class="toolbar"><button id="add-example">＋ 新增示例</button><button id="use-mock">用 Mock 地址调试</button></div>${r.examples.map((e, i) => `<div class="card"><div class="row"><strong class="grow">${esc(e.name)} · ${esc(e.status)}</strong><button data-use-example="${i}">调试此示例</button><button data-edit-example="${i}">编辑</button><button data-delete-example="${i}">删除</button></div><pre>${esc(e.body)}</pre></div>`).join("")}</div>`;
  if (
    mode === "cases" &&
    !(
      caseBatch?.projectId === project.id && caseBatch?.sourceRequestId === r.id
    )
  ) {
    const empty = emptyCasePanel(project, r.id, busy);
    if (empty) return empty;
  }
  if (mode === "cases")
    return `<div class="page"><h2>接口用例</h2><p class="muted">每个用例保存独立请求快照，可覆盖参数、断言和脚本。原接口修改不会自动覆盖用例。分组仅组织用例，移动分组不会改写已保存的请求快照。</p><button id="new-interface-case" class="primary" ${busy ? "disabled" : ""}>＋ 新建接口用例</button><button id="new-case-folder" ${busy ? "disabled" : ""}>＋ 新建用例分组</button><button id="create-case">从当前接口创建执行计划</button>${caseSelectionToolbar()}${caseCards(project, r.id, caseResults.results(project.id), busy, selectedInterfaceCases(), caseResults.collapsed(project.id))}</div>`;
  return `<div class="page"><h2>一键压测</h2><p class="muted">仅对你有权测试的接口使用。最多100次主请求执行、并发10，支持取消。包含脚本、动态值和断言；每次执行的变量独立，不回写项目。脚本子请求另计（各自受沙箱上限约束），HTTP调用数不等于网络往返次数。P50/P95是主请求耗时，逐次elapsed另含脚本等待；脚本与子请求也可能产生副作用。</p><p class="muted">按时长模式限定1至60秒，仍受请求上限约束；先到时长或请求上限即停止，不保证持续到指定秒数。到时会中断尚未完成的请求和脚本，并保留记录。</p><div class="row load-controls"><label>模式 <select id="load-mode" ${busy ? "disabled" : ""}><option value="count" ${loadOptions.get(project.id + ":" + r.id)?.mode !== "duration" ? "selected" : ""}>按请求数</option><option value="duration" ${loadOptions.get(project.id + ":" + r.id)?.mode === "duration" ? "selected" : ""}>按持续时长</option></select></label><label>时长（秒，仅时长模式） <input id="load-duration" type="number" min="1" max="60" value="${esc(loadOptions.get(project.id + ":" + r.id)?.durationSeconds ?? 10)}" ${busy ? "disabled" : ""}></label><label>请求数 / 上限 <input id="load-count" type="number" value="${esc(loadOptions.get(project.id + ":" + r.id)?.count ?? 10)}" min="1" max="100"></label><label>并发 <input id="load-concurrency" type="number" value="${esc(loadOptions.get(project.id + ":" + r.id)?.concurrency ?? 1)}" min="1" max="10"></label><button id="load-run" class="primary" ${busy ? "disabled" : ""}>开始压测</button>${busy ? '<button id="cancel">停止</button>' : ""}</div><div class="load-data-panel"><label for="load-data">参数化数据（UTF-8 CSV，可选）</label><p class="muted">首行为变量名，后续行依次循环供 {{变量名}} 使用，仅覆盖本次运行。最多64 KiB、100行、50列；数据只保留在当前页面会话，不保存到项目。</p><textarea id="load-data" rows="4" spellcheck="false" ${busy ? "disabled" : ""} placeholder="id,name&#10;1,示例">${esc(loadOptions.get(project.id + ":" + r.id)?.dataCSV ?? "")}</textarea><label>导入 CSV <input id="load-data-file" type="file" accept=".csv,text/csv" ${busy ? "disabled" : ""}></label></div>${
    loadResult
      ? `<div class="grid-stats">${[
          ["已记录", loadResult.count],
          [
            "停止原因",
            {
              count: "请求数完成",
              "count-limit": "达到请求上限",
              duration: "达到持续时长",
              cancelled: "手动取消",
            }[loadResult.stopReason] || "未知",
          ],
          ["通过", loadResult.passed],
          ["未通过（含中断）", loadResult.count - loadResult.passed],
          ["总耗时", loadResult.elapsed + " ms"],
          ["主请求调用", loadResult.mainRequests ?? loadResult.count],
          ["脚本子请求", loadResult.scriptRequests ?? 0],
          [
            "P50",
            loadResult.timingSamples === 0 ? "—" : loadResult.p50 + " ms",
          ],
          [
            "P95",
            loadResult.timingSamples === 0 ? "—" : loadResult.p95 + " ms",
          ],
        ]
          .map(([l, v]) => `<div class="stat">${l}<strong>${v}</strong></div>`)
          .join(
            "",
          )}</div><pre>${esc(JSON.stringify(loadResult.results, null, 2))}</pre>`
      : ""
  }</div>`;
}
function renderPage() {
  if (page === "socketio")
    return `<div class="page"><button id="socketio-project-reload" ${busy || saving ? "disabled" : ""}>重新加载项目核对（不重发）</button><p class="muted">刷新页面不重连。内存会话可能仍在运行；请显式读取列表核对。定义和消息正文可进入项目历史，临时认证/TLS不保存。</p>${renderSocketIO(socketioWorkbenchState, project.settings?.socketioDefinitions || [])}</div>`;
  if (page === "grpc")
    return `<div class="page"><button id="grpc-project-reload" ${busy || saving ? "disabled" : ""}>重新加载项目核对（不重发）</button><p class="muted">重新加载仅核对本机记录，不证明远端未执行。普通项目草稿和gRPC定义草稿分别保存。</p>${renderGrpcUnary(grpcWorkbenchState, project.settings?.grpcDefinitions || [])}${renderGrpcStream(grpcStreamState, project.settings?.grpcDefinitions || [])}<details><summary>最近已保存gRPC记录（正文保存在项目历史，可能敏感）</summary>${
      (project.protocolRuns || [])
        .filter((item) => item.type === "grpc")
        .slice(-10)
        .reverse()
        .map(
          (item) =>
            `<p>运行 ${esc(item.runId || item.id)} · ${esc(item.createdAt)} · ${esc(item.status)} · gRPC ${esc(item.result?.status?.code)} · ${esc(item.result?.messages?.length || 0)} 条消息</p>`,
        )
        .join("") || "<p>本机暂无已保存记录；不代表远端未执行。</p>"
    }</details></div>`;
  if (!project) return "";
  if (page === "settings")
    return settingsPanel(
      project,
      settingsSection,
      parameterScopes.get(project.id) || "",
      mcpState,
      projects,
    );
  if (page === "plans")
    return renderPlans({ project, planId, lastRun, busy, tab: planTab });
  if (page === "history")
    return `<div class="page"><div class="page-head"><h1>最近请求</h1><button id="history-project-reload" ${busy || saving ? "disabled" : ""}>重新加载项目记录（不重发）</button><span class="muted">本地保留最近 50 条</span></div>${project.history.map((h) => `<div class="card"><div class="row"><span class="method ${h.request?.method}">${h.request?.method}</span><strong class="grow">${esc(h.name)}</strong><span class="${h.response?.status < 400 ? "success" : "failed"}">${h.response?.status || "ERROR"}</span><button data-history="${h.id}">查看</button></div><p class="subtle">${esc(h.createdAt)} · ${esc(h.request?.url)}</p></div>`).join("") || '<div class="empty"><p>暂无请求历史</p></div>'}${protocolHistoryView(project)}</div>`;
  if (page === "trash")
    return `<div class="page"><h1>回收站</h1>${projects
      .filter((p) => p.archived)
      .map(
        (p) =>
          `<div class="list-row"><strong class="grow">归档项目 · ${esc(p.name)}</strong><button data-restore-project="${p.id}">恢复项目</button></div>`,
      )
      .join("")}<p class="muted">删除的接口在这里保留，可随时恢复。</p>${
      project.requests
        .filter((r) => r.deletedAt)
        .map(
          (r) =>
            `<div class="list-row"><span class="method">${r.method}</span><strong class="grow">${esc(r.name)}</strong><span class="subtle">${esc(r.deletedAt)}</span><button data-restore="${r.id}">恢复</button></div>`,
        )
        .join("") || '<div class="empty"><p>回收站为空</p></div>'
    }</div>`;
  if (page === "dictionary")
    return `<div class="page">${dictionaryPanel(project, temporaryParameters.get(project.id) || [])}<div class="page-head"><div><h1>数据模型</h1><span class="muted">统一管理可复用的字段定义与枚举</span></div><div class="toolbar"><button id="add-model-folder">＋ 新建目录</button><button id="add-dictionary" class="primary">＋ 新建数据模型</button></div></div>${modelCards(project)}</div>`;
  if (page === "protocols")
    return `<div class="page"><h1>实时协议调试</h1><div class="row"><input id="protocol-name" placeholder="连接名称" value="${esc(project.protocols?.find((item) => item.id === selectedProtocolId)?.name || "")}"><button id="save-protocol">保存连接定义</button><button id="delete-protocol" class="danger">删除连接定义</button></div><p class="muted">支持短时采集与交互会话。交互会话最长 15 分钟、8 MiB，保留最近 200 条消息。</p><div class="form-grid"><label>协议</label><select id="protocol-type">${[
      ["sse", "SSE"],
      ["websocket", "WebSocket"],
      ["tcp", "TCP"],
    ]
      .map(
        ([type, label]) =>
          `<option value="${type}" ${(project.protocols?.find((item) => item.id === selectedProtocolId)?.type || "sse") === type ? "selected" : ""}>${label}</option>`,
      )
      .join(
        "",
      )}</select><label>URL / TCP Host</label><input id="protocol-url" placeholder="http://localhost:8080/events" value="${esc(project.protocols?.find((item) => item.id === selectedProtocolId)?.url || "")}"><label>TCP 端口</label><input id="protocol-port" type="number" value="${project.protocols?.find((item) => item.id === selectedProtocolId)?.port || 8080}"><label>采集时长 ms</label><input id="protocol-duration" type="number" value="3000" min="100" max="30000"><label>发送消息</label><textarea id="protocol-message"></textarea></div><p><button id="protocol-run" class="primary" ${busy ? "disabled" : ""}>连接并采集</button> <button id="cancel">断开</button></p><pre id="protocol-result"></pre><div class="card"><div class="toolbar"><strong>当前全局会话</strong><button id="session-connect" class="primary" ${sessionState.canConnect ? "" : "disabled"}>建立交互会话</button><button id="session-send" ${sessionState.canSend ? "" : "disabled"}>发送消息</button><button id="session-stop" ${sessionState.canStop ? "" : "disabled"}>断开会话</button><button id="session-refresh">核对会话</button><button id="session-export">导出消息</button><span id="session-status">${esc(sessionLabel())}</span></div><pre id="session-events">${esc(activeSession?.events?.map((event) => `${event.at} ${event.direction} ${event.data}`).join("\n") || "")}</pre></div></div>`;
  if (page === "database")
    return `<div class="page"><h1>数据库连接</h1><p class="muted">SQLite / PostgreSQL / MySQL / Redis / MongoDB / ClickHouse · 默认只读 · 最多返回 1000 行</p><div class="form-grid"><label>类型</label><select id="db-type"><option value="sqlite">SQLite</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="clickhouse">ClickHouse（HTTP只读）</option><option value="redis">Redis（默认只读）</option><option value="mongodb">MongoDB（find只读）</option></select><label>主机</label><input id="db-host" value="127.0.0.1"><label>端口</label><input id="db-port" placeholder="5432 / 3306 / 6379"><label>用户名</label><input id="db-user" autocomplete="off"><label>密码</label><input id="db-password" type="password" autocomplete="off"><label>数据库名 / Redis数据库索引</label><input id="db-name"><label>MongoDB认证库</label><input id="db-auth-source" value="admin"><label>TLS</label><input id="db-tls" type="checkbox"><label>自定义CA（PEM，可选）</label><textarea id="db-ca" placeholder="留空使用系统信任的证书"></textarea><label>达梦客户端证书链（PEM，双向 TLS）</label><textarea id="db-client-cert" spellcheck="false" autocomplete="off"></textarea><label>达梦客户端私钥（PEM，双向 TLS）</label><textarea id="db-client-key" spellcheck="false" autocomplete="off"></textarea><label>服务端证书 DN</label><input id="db-server-dn" placeholder="CN=db.example.com"><label>授权表（每行一个 SCHEMA.TABLE，有效期 15 分钟）</label><textarea id="db-relations" placeholder="APP.ITEMS"></textarea><label>SQLite 文件路径</label><input id="db-path" placeholder="C:\\data\\app.db 或 /data/app.db"><label>SQL / Redis命令JSON数组（如 ["GET","key"]）</label><textarea id="db-sql">SELECT name FROM sqlite_master WHERE type = 'table'</textarea><label>绑定参数 JSON</label><input id="db-params" value="[]"></div><p><label id="db-write-label"><input id="db-write" type="checkbox"><span id="db-write-description">仅本次允许SQLite写入（INSERT / UPDATE / DELETE）</span></label></p><p><button id="db-query" class="primary">执行只读查询</button> <button id="db-register">授权为本项目会话连接</button> <button id="db-connections">管理会话连接</button></p><p id="db-sqlserver-notice" class="notice" hidden>SQL Server 只读预览：必须验证TLS，目标数据库须为 READ_ONLY；仅显式 schema.table 列查询，参数使用 @p0。最多1000行，不支持写入/SSH。尚未完成真实服务与 Windows 验收。</p><pre id="db-result"></pre><div class="notice">连接凭据仅本次使用，不自动保存。仅连接你有权访问的数据库；只读事务不能保证数据库自定义函数无外部副作用。</div></div>`;
  if (page === "git")
    return `<div class="page"><h1>Git 协同</h1><p><button id="git-terminal" class="primary">在项目位置打开终端</button></p><p class="muted">本地项目是格式化 JSON 文件，可以纳入你自己的 Git 仓库。</p><div class="card"><h3>推荐流程</h3><ol class="markdown"><li>导出项目，检查并移除环境密钥与历史中的敏感信息。</li><li>把接口定义文件放入项目仓库。</li><li>通过 Git diff 审查变更，通过 PR 协作。</li><li>其他成员导入同一文件，继续本地编辑。</li></ol><button id="export">导出项目文件</button></div><div class="notice">打开终端后由你执行 Git 命令；本应用不会自动提交凭据或推送代码。执行记录与历史可能含敏感数据，请勿公开提交。</div></div>`;
  return `<div class="page"><div class="page-head"><div><h1>接口文档</h1><span class="muted">从当前项目定义生成，离线阅读与导出</span></div><div class="toolbar"><button id="new-document">＋ 新建文档</button><button id="export-docs" class="primary">导出文档</button></div></div>${
    errorCodeHTML(project.settings?.statusCodes || []) +
      project.documents
        .map(
          (document, index) =>
            `<article class="card markdown"><div class="row"><h3 class="grow">${esc(document.title)}</h3><span class="subtle">${esc((project.settings?.statuses || []).find((status) => status.id === document.statusId)?.name || "")}</span><button data-edit-document="${index}">编辑</button><button data-delete-document="${index}" class="danger">删除</button></div><div class="markdown-content">${renderMarkdown(document.content)}</div></article>`,
        )
        .join("") +
      project.requests
        .filter((r) => !r.deletedAt)
        .map(
          (r) =>
            `<article class="card markdown"><div class="row"><span class="method ${esc(r.method)}">${esc(r.method)}</span><h3>${esc(r.name)}</h3></div><pre>${esc(r.url)}</pre><div class="markdown-content">${renderMarkdown(r.description || "暂无描述")}</div>${requestDocumentationHTML(r, 4)}</article>`,
        )
        .join("") || '<div class="empty"><p>创建接口后自动生成文档</p></div>'
  }</div>`;
}
function on(selector, event, fn) {
  document.querySelectorAll(selector).forEach((el) =>
    el.addEventListener(event, async (e) => {
      try {
        await fn(e, el);
      } catch (err) {
        toast(err.message);
      }
    }),
  );
}
function download(name, data, type = "application/json") {
  const u = URL.createObjectURL(
    new Blob(
      [typeof data === "string" ? data : JSON.stringify(data, null, 2)],
      { type },
    ),
  );
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
function addRequest() {
  collect();
  const r = defaultRequest();
  project.requests.push(r);
  current = r.id;
  activeDocumentId = null;
  if (!opened.includes(r.id)) opened.push(r.id);
  page = "apis";
  mode = "debug";
  response = null;
  mark();
  render();
}
function assertExecutionReady() {
  if (busy || saving) throw Error("请等待当前请求或保存结束");
  nativeRequestLifecycle.reloadCheckpoint();
  nativeRequestLifecycle.assertCanSave(project.id);
  projectImports.assertCanStart(project.id, "execution");
}
async function prepareProjectWrite(mode) {
  assertExecutionReady();
  const projectId = project.id,
    operation = projectImports.begin(projectId, mode);
  try {
    collect();
    if (dirty) await operation.saveDraft(save);
    if (project.id !== projectId || dirty || busy || saving)
      throw Error("项目或草稿在保存期间已变化，未开始后续操作");
    const owner = project,
      version = editVersion,
      openingSequence = projectOpenSequence,
      plans = JSON.stringify(project.plans);
    return {
      projectId,
      operation,
      assertCurrent(updated) {
        const planChanged =
          project === owner && JSON.stringify(project.plans) !== plans;
        if (planChanged && !dirty) mark();
        if (
          project !== owner ||
          editVersion !== version ||
          dirty ||
          projectOpenSequence !== openingSequence ||
          saving ||
          planChanged ||
          (updated && updated.id !== projectId)
        )
          throw Error("项目或草稿已变化，未应用迟到的写入结果");
      },
      uncertain(error) {
        operation.requireReconciliation();
        return Error(
          error.message +
            "。操作可能已完成，请先复制草稿并重新加载原项目核对；不会自动重放，核对后可明确重新执行。",
        );
      },
    };
  } catch (error) {
    operation.finish();
    throw error;
  }
}
async function savePlan(plan) {
  plan = structuredClone(plan);
  const selectedPlan = planId,
    write = await prepareProjectWrite("plan");
  let posted = false;
  try {
    write.assertCurrent();
    posted = true;
    const result = await api(
      "/projects/" + write.projectId + "/plans",
      "POST",
      {
        ...plan,
        projectConfigRevision: project.configRevision ?? project.revision,
      },
    );
    write.assertCurrent();
    const {
      projectRevision,
      projectConfigRevision,
      projectFingerprint,
      ...saved
    } = result;
    if (!saved.id || (plan.id && saved.id !== plan.id))
      throw Error("返回计划身份不匹配");
    const index = project.plans.findIndex((item) => item.id === saved.id);
    if (index < 0) project.plans.push(saved);
    else project.plans[index] = saved;
    if (planId === selectedPlan) planId = saved.id;
    project.revision = projectRevision;
    project.configRevision = projectConfigRevision;
    project._diskFingerprint = projectFingerprint;
    render();
  } catch (error) {
    if (posted) throw write.uncertain(error);
    throw error;
  } finally {
    write.operation.finish();
  }
}

function editRules() {
  const r = request();
  const sample = {
    assertions: [{ target: "status", op: "eq", value: 200 }],
    extract: [
      { name: "token", source: "json", path: "$.token" },
      {
        name: "xmlName",
        source: "xml",
        path: "/x:root/x:name/text()",
        namespaces: { x: "urn:example" },
        scope: "runtime",
      },
    ],
    before: [{ type: "uuid", name: "requestId" }],
    after: [{ type: "set", name: "completed", value: "true" }],
  };
  modal(
    "编辑 " + param,
    `<p>示例</p><pre>${esc(JSON.stringify(sample[param], null, 2))}</pre>${jsonEditor(r[param])}`,
    () => {
      const value = JSON.parse($("#modal-json").value);
      if (!Array.isArray(value)) throw Error("必须是数组");
      r[param] = value;
      mark();
      render();
    },
  );
}
function showMCPClientConfiguration(configuration) {
  let selected = "Cursor";
  modal(
    "MCP 连接配置",
    `<div class="toolbar">${mcpClients.map((client) => `<button data-mcp-client="${esc(client)}">${esc(client)}</button>`).join("")}</div><pre id="mcp-client-code">${esc(clientConfiguration(selected, configuration))}</pre><p class="muted">配置只在本机显示/复制，不会自动联系任何 Agent。模板按客户端格式生成；仍需在客户端允许此连接。Trae 为通用 HTTP 模板，尚未逐客户端实机验证。</p>`,
    () =>
      navigator.clipboard.writeText(
        clientConfiguration(selected, configuration),
      ),
    "复制配置",
  );
  for (const button of document.querySelectorAll("[data-mcp-client]"))
    button.onclick = () => {
      selected = button.dataset.mcpClient;
      $("#mcp-client-code").textContent = clientConfiguration(
        selected,
        configuration,
      );
      for (const item of document.querySelectorAll("[data-mcp-client]"))
        item.classList.toggle("primary", item === button);
    };
}
function bind() {
  bindSocketIOWorkbench();
  on("#socketio-project-reload", "click", () => openProject(project.id));
  bindGrpcWorkbench();
  bindGrpcStreamWorkbench();
  on("#grpc-project-reload", "click", () => openProject(project.id));
  const mcpPanel = $("#settings-mcp");
  updateMCPPanel = mcpPanel
    ? bindMCPSettings(mcpPanel, {
        projects,
        initial: mcpState,
        loadConfig: () => api("/mcp/config"),
        copy: (text) => navigator.clipboard.writeText(text),
      })
    : null;
  if (mcpPanel) {
    const updateService = updateMCPPanel;
    const updateDatabase = bindMCPDatabase(mcpPanel, {
      projectId: project.id,
      config: mcpState,
      loadCapabilities: loadDatabasePreviewCapabilities,
      request: api,
    });
    updateMCPPanel = (config) => {
      updateService(config);
      updateDatabase(config);
    };
  }
  const visualizationFrame = $("#response-visualization");
  if (visualizationFrame) {
    try {
      mountVisualization(visualizationFrame, response.visualization, document);
    } catch (error) {
      visualizationFrame.replaceWith(document.createTextNode(error.message));
    }
  }
  on("#cookie-manager", "click", () => openCookieManager());
  on("#compact-ui", "click", () => {
    collect();
    compactUI = !compactUI;
    localStorage.setItem("compact-ui", String(compactUI));
    render();
  });
  on("#response-layout", "click", () => {
    collect();
    responseLayout = responseLayout === "split" ? "stacked" : "split";
    localStorage.setItem("response-layout", responseLayout);
    render();
  });
  on("[data-page]", "click", (event, e) => {
    const fromRailKeyboard =
      event.detail === 0 && e === document.activeElement && e.closest(".rail");
    collect();
    bodyExpanded = false;
    page = e.dataset.page;
    if (e.dataset.settingsTarget) settingsSection = e.dataset.settingsTarget;
    if (page === "plans") planTab = "plans";
    render();
    if (fromRailKeyboard) $(".rail [aria-current='page']")?.focus();
  });
  bindWorkspaceDocument();
  on("[data-open-document-tab]", "click", (event, button) => {
    const keyboard = event.detail === 0 && button === document.activeElement;
    openWorkspaceDocument(button.dataset.openDocumentTab);
    if (keyboard) $(".tab.selected .tab-switch")?.focus();
  });
  on("[data-close-document-tab]", "click", (event, button) => {
    const keyboard = event.detail === 0 && button === document.activeElement;
    const id = button.dataset.closeDocumentTab;
    openedDocuments = openedDocuments.filter((entry) => entry !== id);
    if (activeDocumentId === id)
      activeDocumentId = openedDocuments.at(-1) ?? null;
    render();
    if (keyboard) ($(".tab.selected .tab-switch") || $("#tab-add"))?.focus();
  });
  on("[data-open-tab]", "click", (event, e) => {
    const fromKeyboard = event.detail === 0 && e === document.activeElement;
    collect();
    current = e.dataset.openTab;
    activeDocumentId = null;
    response = responses.get(project.id + ":" + current) || null;
    render();
    if (fromKeyboard) $(".tab.selected .tab-switch")?.focus();
  });
  on("[data-close-tab]", "click", (event, e) => {
    const fromKeyboard = event.detail === 0 && e === document.activeElement;
    collect();
    opened = opened.filter((id) => id !== e.dataset.closeTab);
    if (current === e.dataset.closeTab) {
      current = opened.at(-1);
      response = responses.get(project.id + ":" + current) || null;
    }
    render();
    if (fromKeyboard)
      ($(".tab.selected .tab-switch") || $("#tab-add"))?.focus();
  });
  on("#git-terminal", "click", async () => {
    if (window.desktop?.openProjectTerminal)
      return window.desktop.openProjectTerminal(project.id);
    const location = await api("/projects/" + project.id + "/location");
    modal(
      "项目位置",
      `<pre>${esc(location.path)}</pre><p>浏览器模式请在该文件所在目录自行打开终端。桌面版可直接打开。</p>`,
      () => navigator.clipboard.writeText(location.path),
      "复制路径",
    );
  });
  on("#open-location", "click", async () => {
    if (window.desktop?.openProjectLocation)
      return window.desktop.openProjectLocation(project.id);
    const location = await api("/projects/" + project.id + "/location");
    modal(
      "本地项目位置",
      `<pre>${esc(location.path)}</pre><p>浏览器模式请在文件管理器中打开此路径。</p>`,
      () => navigator.clipboard.writeText(location.path),
      "复制路径",
    );
  });
  on("#mcp-config", "click", async () => {
    const config = await api("/mcp/config");
    modal(
      "MCP 项目授权",
      `${config.warning ? `<p class="notice">${esc(config.warning)}</p>` : ""}<details><summary>stdio共享进度</summary><p>stdio客户端需将LOCAL_API_DATA环境变量设为此数据根目录，并单独授权project/write/execute。HTTP开关不代替stdio权限。</p><pre>${esc(config.dataRoot)}</pre></details><label><input id="mcp-enabled" type="checkbox" ${config.enabled ? "checked" : ""}> 开启本地 MCP 服务</label><label><input id="mcp-write" type="checkbox" ${config.write ? "checked" : ""}> 允许写入项目</label><label><input id="mcp-execute" type="checkbox" ${config.execute ? "checked" : ""}> 允许执行已有计划（会向计划 URL 发送请求）</label><label><input id="mcp-remember" type="checkbox" ${config.remember ? "checked" : ""}>下次启动保留本机授权、端口和连接密钥</label><label><input id="mcp-rotate" type="checkbox">重新生成连接密钥（使旧配置失效）</label><p class="notice">持久授权会将连接密钥写入本机应用数据目录；仅对可信客户端开启，不要分享配置。</p><h4>授权项目</h4>${projects.map((p) => `<label><input data-mcp-project="${p.id}" type="checkbox" ${config.projects.includes(p.id) ? "checked" : ""}> ${esc(p.name)}</label>`).join("")}<div class="notice">凭据只用于本机 MCP 接入。不要分享给不信任的 Agent。关闭服务会立即撤销当前令牌。</div>`,
      async () => {
        const result = await api("/mcp/config", "POST", {
          enabled: $("#mcp-enabled").checked,
          write: $("#mcp-write").checked,
          execute: $("#mcp-execute").checked,
          remember: $("#mcp-remember").checked,
          rotate: $("#mcp-rotate").checked,
          projects: [
            ...document.querySelectorAll("[data-mcp-project]:checked"),
          ].map((e) => e.dataset.mcpProject),
        });
        mcpPollSequence++;
        mcpState = result;
        updateMCPPanel?.(result);
        if (result.enabled) {
          setTimeout(() => showMCPClientConfiguration(result), 0);
        } else toast("MCP 已关闭，令牌已撤销");
      },
      "应用授权",
    );
  });
  on("#theme", "click", () => {
    document.body.classList.toggle("dark");
    localStorage.setItem(
      "theme",
      document.body.classList.contains("dark") ? "dark" : "light",
    );
  });
  on("#project-select", "change", (_, e) => openProject(e.value));
  on("#env", "change", (_, e) => {
    project.currentEnvironmentId = e.value;
    mark();
  });
  on("#search", "input", (_, e) => {
    search = e.value;
    $("#tree").innerHTML = tree();
    bindTree();
  });
  bindTree();
  on("#new-folder", "click", () =>
    modal("新建目录", '<label>目录名称</label><input id="folder-name">', () => {
      const name = $("#folder-name").value.trim();
      if (!name) throw Error("名称不能为空");
      project.folders = [...new Set([...(project.folders || []), name])];
      mark();
      render();
    }),
  );
  on("#new-document", "click", () => editDocument());
  on("[data-edit-document]", "click", (_, element) =>
    editDocument(Number(element.dataset.editDocument)),
  );
  on("[data-delete-document]", "click", (_, element) => {
    if (!confirm("删除此项目文档？")) return;
    project.documents.splice(Number(element.dataset.deleteDocument), 1);
    mark();
    render();
  });
  on("#new-project", "click", () =>
    modal(
      "新建本地项目",
      '<label>项目名称</label><input id="new-name" placeholder="例如：商城服务"><label>存储目录（留空使用默认目录）</label><input id="new-directory" placeholder="绝对路径"><button id="pick-directory" type="button">选择本地文件夹</button>',
      async () => {
        const p = await api("/projects", "POST", {
          name: $("#new-name").value,
          directory: $("#new-directory").value || undefined,
        });
        projects = await api("/projects");
        await openProject(p.id);
      },
    ),
  );
  on("#add-request,#new-request,#tab-add,#welcome-add", "click", addRequest);
  on("#save,#save-project", "click", save);
  on("#request-name,#url,#body-code,#description", "input", (_, element) => {
    collect();
    mark();
    if (element.id === "request-name") {
      const id = CSS.escape(current);
      document
        .querySelectorAll('[data-tab-name="' + id + '"]')
        .forEach((label) => {
          label.textContent = request().name;
        });
      document
        .querySelector('[data-close-tab="' + id + '"]')
        ?.setAttribute("aria-label", "关闭 " + request().name);
      if ($("#tree")) {
        $("#tree").innerHTML = tree();
        bindTree();
      }
    }
  });
  on("#method", "change", () => {
    collect();
    mark();
    render();
  });
  const editResponseSchema = (index = -1, media = "application/json") => {
    collect();
    const responses = structuredClone(request().responses || []),
      definition = responses[index] || {},
      schema = definition.content?.[media]?.schema ?? {
        type: "object",
        properties: {},
      };
    let readSchema;
    modal(
      "编辑响应定义",
      '<div class="response-schema-meta"><label>状态<input id="schema-response-status" value="' +
        esc(
          definition.status ||
            (responses.some((item) => String(item.status) === "200")
              ? ""
              : "200"),
        ) +
        '" placeholder="201 / 4XX / default"></label><label>Content-Type<input id="schema-response-media" value="' +
        esc(media) +
        '"></label><label>说明<input id="schema-response-description" value="' +
        esc(definition.description || "") +
        '"></label></div><p class="muted">更换 Content-Type 会添加新类型。已有类型请切换后直接编辑，原有类型及示例不会被覆盖。</p><div id="schema-editor">' +
        schemaEditor(schema) +
        "</div>",
      () => {
        Object.assign(
          request(),
          editRequestResponseDefinition({ ...request(), responses }, index, {
            status: $("#schema-response-status").value,
            description: $("#schema-response-description").value,
            mediaType: $("#schema-response-media").value,
            sourceMediaType: media,
            schema: readSchema(),
          }),
        );
        const r = request();
        const edited = index < 0 ? r.responses.at(-1) : r.responses[index];
        designResponseSelections.set(designResponseKey(r), {
          status: String(edited.status),
          media: $("#schema-response-media").value.trim(),
        });
        mark();
        render();
      },
    );
    readSchema = bindSchemaEditor($("#schema-editor"), schema);
  };
  const selectDesignResponse = (index, media, focus) => {
    const r = request();
    const before = r.responses?.[index];
    const status = before ? String(before.status) : undefined;
    const top = $(".http-design-canvas").scrollTop;
    collect();
    const key = designResponseKey(r);
    const current = designResponseSelections.get(key);
    const selection = responseSelection(r.responses, { status, media });
    designResponseSelections.set(key, {
      view: current?.view,
      bodyView: current?.bodyView,
      status: selection.definition
        ? String(selection.definition.status)
        : undefined,
      media: selection.media,
    });
    render();
    $(".http-design-canvas").scrollTop = top;
    $(
      focus === "media"
        ? "#design-response-media"
        : "#design-response-" + selection.index,
    )?.focus();
  };
  on("[data-design-response]", "click", (_, e) =>
    selectDesignResponse(Number(e.dataset.designResponse), undefined, "tab"),
  );
  on("[data-design-response]", "keydown", (event, e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const size = request().responses.length;
    const index = Number(e.dataset.designResponse);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? size - 1
          : (index + (event.key === "ArrowRight" ? 1 : size - 1)) % size;
    selectDesignResponse(next, undefined, "tab");
  });
  on("#design-response-media", "change", (_, e) => {
    const r = request();
    const previous = responseSelection(
      r.responses,
      designResponseSelections.get(designResponseKey(r)),
    );
    try {
      selectDesignResponse(previous.index, e.value, "media");
    } catch (error) {
      e.value = previous.media;
      throw error;
    }
  });
  on("[data-response-view]", "click", (_, e) => {
    const r = request();
    collect();
    const key = designResponseKey(r);
    const top = $(".http-design-canvas").scrollTop;
    designResponseSelections.set(key, {
      ...designResponseSelections.get(key),
      view: e.dataset.responseView,
    });
    render();
    $(".http-design-canvas").scrollTop = top;
    $("#design-response-view-" + e.dataset.responseView)?.focus();
  });
  on("[data-response-body-view]", "click", (_, e) => {
    const r = request();
    collect();
    const key = designResponseKey(r);
    const top = $(".http-design-canvas").scrollTop;
    designResponseSelections.set(key, {
      ...designResponseSelections.get(key),
      bodyView: e.dataset.responseBodyView,
    });
    render();
    $(".http-design-canvas").scrollTop = top;
    $("#design-body-view-" + e.dataset.responseBodyView)?.focus();
  });
  const rootSelector = "[data-design-response-root]";
  const rootState = (root) => {
    const r = request();
    const raw = $("#response-definitions");
    let rawDraft;
    try {
      rawDraft = JSON.parse(raw.value);
    } catch {
      throw Error("响应定义必须是有效JSON数组");
    }
    if (JSON.stringify(rawDraft) !== JSON.stringify(r.responses))
      throw Error(
        "响应定义 JSON 有未应用的修改，请先保存或切换响应后再编辑根节点",
      );
    collect();
    const selection = designResponseSelections.get(designResponseKey(r));
    const { definition, index, media } = responseSelection(
      r.responses,
      selection,
    );
    const scope = [index, String(definition?.status), media];
    if (JSON.stringify(scope) !== root.dataset.designResponseRoot)
      throw Error("响应根节点已变化，请重新打开");
    const snapshot = raw.value;
    const owner = project;
    return {
      definition,
      media,
      apply(action, value, focus, deferFocus = false) {
        if (
          project !== owner ||
          request() !== r ||
          !root.isConnected ||
          raw.value !== snapshot ||
          r.responses[index] !== definition
        )
          throw Error("响应草稿已变化，请重新打开");
        if (
          action === "type" &&
          value !== definition.content[media].schema.type &&
          scopedResponseExamples(r.examples, definition.status, media).length
        )
          throw Error("此根类型变更可能影响现有示例，请使用响应定义 JSON");
        const next = editDesignResponseRoot(definition, media, action, value);
        if (next === definition) return false;
        r.responses[index] = next;
        if (action === "add")
          collapsedDesignResponseRoots
            .get(r)
            ?.delete(JSON.stringify(scope.slice(1)));
        const top = $(".http-design-canvas").scrollTop;
        mark();
        render();
        $(".http-design-canvas").scrollTop = top;
        if (!deferFocus) $(focus)?.focus({ preventScroll: true });
        return true;
      },
    };
  };
  on("#design-response-root-toggle", "click", (_, button) => {
    const r = request();
    const root = button.closest(rootSelector);
    const [, status, media] = JSON.parse(root.dataset.designResponseRoot);
    const key = JSON.stringify([status, media]);
    const scopes = collapsedDesignResponseRoots.get(r) || new Set();
    const collapse = button.getAttribute("aria-expanded") === "true";
    if (collapse) scopes.add(key);
    else scopes.delete(key);
    collapsedDesignResponseRoots.set(r, scopes);
    button.setAttribute("aria-expanded", String(!collapse));
    $("#design-response-root-children").hidden = collapse;
  });
  let descriptionEdit;
  let originalRootDescription;
  const disableOtherRootEdits = (disabled) => {
    for (const control of document.querySelectorAll(
      "#design-response-root-add,#design-response-root-type",
    ))
      control.disabled = disabled;
  };
  const closeRootDescription = () => {
    const button = $("#design-response-root-description");
    $("#design-response-root-form").hidden = true;
    button.setAttribute("aria-expanded", "false");
    disableOtherRootEdits(false);
    button.focus();
    descriptionEdit = undefined;
  };
  on("#design-response-root-description", "click", (_, button) => {
    if (descriptionEdit) return closeRootDescription();
    descriptionEdit = rootState(button.closest(rootSelector));
    const description = $("#design-response-root-description-value");
    description.value =
      descriptionEdit.definition.content[descriptionEdit.media].schema
        .description ?? "";
    originalRootDescription = description.value;
    $("#design-response-root-form").hidden = false;
    button.setAttribute("aria-expanded", "true");
    disableOtherRootEdits(true);
    description.focus();
  });
  on("#design-response-root-form", "submit", (event) => {
    event.preventDefault();
    const value = $("#design-response-root-description-value").value;
    if (value === originalRootDescription) return closeRootDescription();
    const changed = descriptionEdit?.apply(
      "description",
      value,
      "#design-response-root-description",
    );
    if (!changed) closeRootDescription();
  });
  on("#design-response-root-form", "keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeRootDescription();
  });
  on("#design-response-root-cancel", "click", closeRootDescription);

  const editRootInModal = (button, action) => {
    const owner = project,
      requestOwner = request();
    const root = button.closest(rootSelector);
    const scope = root.dataset.designResponseRoot;
    const edit = rootState(root);
    const schema = edit.definition.content[edit.media].schema;
    const type = action === "type";
    const focus = "#" + button.id;
    modal(
      type ? "编辑根节点类型" : "添加根字段",
      type
        ? responseRootTypeFields(schema)
        : '<label for="design-response-root-field">根字段名称</label><input id="design-response-root-field" maxlength="200" autocomplete="off">',
      () =>
        edit.apply(
          action,
          $(
            type
              ? "#design-response-root-type-value"
              : "#design-response-root-field",
          ).value,
          focus,
          true,
        ),
      "应用到草稿",
      () => {
        if (
          owner === project &&
          requestOwner === request() &&
          $(rootSelector)?.dataset.designResponseRoot === scope
        )
          ($(focus) || $("#design-body-view-schema"))?.focus({
            preventScroll: true,
          });
      },
    );
    if (type) $("#design-response-root-type-value").focus();
  };
  on("#design-response-root-type", "click", (_, button) =>
    editRootInModal(button, "type"),
  );
  on("#design-response-root-add", "click", (_, button) =>
    editRootInModal(button, "add"),
  );
  const openDesignExample = (index) => {
    const r = request();
    collect();
    const selected = responseSelection(
      r.responses,
      designResponseSelections.get(designResponseKey(r)),
    );
    const { definition, media } = selected;
    if (
      !supportsDesignExamples(
        definition,
        media,
        r.openapiExampleBindingsVersion === 1,
      )
    )
      throw Error("当前状态或媒体类型不支持在此编辑示例");
    if (
      index !== undefined &&
      !scopedResponseExamples(r.examples, definition.status, media).some(
        (row) => row.index === index,
      )
    )
      throw Error("示例不属于当前状态或媒体类型");
    editExample(index, { definition, media });
  };
  on("#new-design-example", "click", () => openDesignExample());
  on("[data-edit-design-example]", "click", (_, e) =>
    openDesignExample(Number(e.dataset.editDesignExample)),
  );
  const editResponseHeader = (name = null) => {
    const r = request();
    collect();
    const { definition, index } = responseSelection(
      r.responses,
      designResponseSelections.get(designResponseKey(r)),
    );
    if (!definition) throw Error("请先选择响应");
    const header =
      name === null
        ? { schema: { type: "string" } }
        : definition.headers?.[name];
    if (header === undefined) throw Error("响应头已不存在，请重新打开");
    modal(
      name === null ? "新增响应头" : "编辑响应头",
      '<div class="design-response-header-fields">' +
        headerEditorFields(name ?? "", header) +
        "</div>",
      () => {
        if (request() !== r || r.responses[index] !== definition)
          throw Error("响应草稿已变化，请重新打开");
        let next;
        try {
          next = JSON.parse($("#design-header-json").value);
        } catch {
          throw Error("响应头定义必须是有效的 JSON 对象");
        }
        r.responses[index] = editDesignResponseHeader(
          definition,
          name,
          $("#design-header-name").value,
          next,
        );
        mark();
        render();
        $("#design-response-view-headers")?.focus();
      },
    );
  };
  on("#new-response-header", "click", () => editResponseHeader());
  on("[data-response-header]", "click", (_, e) =>
    editResponseHeader(e.dataset.responseHeader),
  );
  on("#edit-design-response-settings", "click", () => {
    const r = request();
    collect();
    const key = designResponseKey(r);
    const selection = designResponseSelections.get(key);
    const { definition, index } = responseSelection(r.responses, selection);
    if (!definition) throw Error("请先选择响应");
    const top = $(".http-design-canvas").scrollTop;
    modal(
      "编辑响应定义设置",
      `<div class="design-response-header-fields"><label>HTTP 状态<input id="design-settings-status" value="${esc(definition.status)}" placeholder="200 / 4XX / default"></label><label>响应说明<textarea id="design-settings-description" maxlength="8192" rows="4">${esc(definition.description || "")}</textarea></label><p class="muted">更改状态会更新绑定的 OpenAPI 示例。独立 Mock 示例保留原有状态，可在原示例编辑器中调整。</p></div>`,
      () => {
        if (request() !== r || r.responses[index] !== definition)
          throw Error("响应草稿已变化，请重新打开");
        Object.assign(
          r,
          editRequestResponseSettings(r, index, {
            status: $("#design-settings-status").value,
            description: $("#design-settings-description").value,
          }),
        );
        designResponseSelections.set(key, {
          ...selection,
          status: String(r.responses[index].status),
        });
        mark();
        render();
        $(".http-design-canvas").scrollTop = top;
        $("#edit-design-response-settings")?.focus();
      },
    );
  });
  on("#new-response-schema", "click", () => editResponseSchema());
  on("[data-response-schema]", "click", (_, element) =>
    editResponseSchema(...JSON.parse(element.dataset.responseSchema)),
  );
  on("#visual-schema", "click", () => {
    collect();
    const schema = request().schema;
    let readSchema;
    modal(
      "编辑请求结构",
      '<div id="schema-editor">' + schemaEditor(schema) + "</div>",
      () => {
        request().schema = readSchema();
        mark();
        render();
      },
    );
    readSchema = bindSchemaEditor($("#schema-editor"), schema);
  });
  on("#folder", "input", (_, e) => {
    request().folder = e.value;
    mark();
  });
  on("#timeout", "change", (_, e) => {
    request().timeout = Number(e.value);
    mark();
  });
  on("#request-proxy", "input", (_, element) => {
    request().proxy = element.value;
    mark();
  });
  on("[data-tls]", "input", (_, element) => {
    request().tls ??= {};
    request().tls[element.dataset.tls] = element.value;
    mark();
  });
  on("#http-version", "change", (_, element) => {
    request().httpVersion = element.value;
    mark();
  });
  on("#response-definitions", "input", () => mark());
  on("#design-description > summary", "click", (_, el) => {
    const r = request();
    const willOpen = !el.parentElement.open;
    openDesignDescriptions.set(r, willOpen);
    if (willOpen)
      $("#design-description-preview").innerHTML = renderMarkdown(
        r.description,
      );
  });
  const applyDesignMarkdown = (action) => {
    const input = $("#description");
    if (!input || !$("#design-description").open) return;
    const edit = markdownEdit(
      action,
      input.value,
      input.selectionStart,
      input.selectionEnd,
    );
    if (!edit || !insertTextareaText(input, edit)) return;
    input.setSelectionRange(edit.anchor, edit.anchor + edit.length);
  };
  on("[data-design-markdown]", "click", (_, el) => {
    applyDesignMarkdown(el.dataset.designMarkdown);
  });
  on("#description", "keydown", (event) => {
    if (
      event.isComposing ||
      event.altKey ||
      event.shiftKey ||
      !(event.ctrlKey || event.metaKey)
    )
      return;
    const action = { b: "bold", i: "italic" }[event.key.toLowerCase()];
    if (typeof action !== "string") return;
    event.preventDefault();
    applyDesignMarkdown(action);
  });
  on("#description", "input", (_, el) => {
    $("#design-description-preview").innerHTML = renderMarkdown(el.value);
    $("#design-description-count").textContent =
      "字数: " +
      Array.from(el.value).length +
      "　行数: " +
      el.value.split("\n").length;
  });
  on("#request-design-preview", "click", () => {
    collect();
    const r = request();
    modal(
      "接口预览",
      `<article class="design-preview"><h2>${esc(r.name)}</h2><p><code>${esc(r.method)} ${esc(r.url)}</code></p><div class="markdown-content">${renderMarkdown(r.description || "暂无详细说明")}</div>${requestDocumentationHTML(r, 4)}</article>`,
      () => {},
      "返回设计",
    );
  });
  on("#share-api", "click", () => {
    collect();
    modal(
      "分享当前接口",
      "<p>生成单接口离线HTML文件。请检查参数和示例中的密钥/业务数据后再分享。</p>" +
        attributeChooser(project),
      () => {
        download(
          request().name + ".html",
          exportDocumentation(
            { ...project, documents: [], requests: [request()] },
            "html",
            { attributeKeys: selectedSharedAttributes() },
          ),
          "text/html",
        );
      },
      "生成离线文档",
    );
  });
  function editParameterEntry(id, initial) {
    const entry = (project.parameterDictionary || []).find(
      (item) => item.id === id,
    ) ||
      initial || { key: "", type: "string", description: "", note: "" };
    modal(
      "字典参数",
      `<label>参数名</label><input id="dict-key" value="${esc(entry.key)}"><label>类型</label><select id="dict-type">${["string", "integer", "number", "boolean", "object", "array"].map((type) => `<option ${type === entry.type ? "selected" : ""}>${type}</option>`).join("")}</select><label>说明</label><input id="dict-description" value="${esc(entry.description)}"><label>备注</label><input id="dict-note" value="${esc(entry.note)}"><label>默认值 / 示例 / 枚举（JSON对象）</label>${jsonEditor(Object.fromEntries(["default", "example", "enum"].filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]])))}`,
      async () => {
        const extras = JSON.parse($("#modal-json").value);
        if (!extras || typeof extras !== "object" || Array.isArray(extras))
          throw Error("扩展定义必须是JSON对象");
        const key = $("#dict-key").value.trim();
        if (
          !key ||
          key.length > 200 ||
          ["__proto__", "prototype", "constructor"].includes(key)
        )
          throw Error("参数名无效");
        if (extras.enum !== undefined && !Array.isArray(extras.enum))
          throw Error("枚举值必须是数组");
        const previous = structuredClone(project.parameterDictionary || []);
        const value = {
          ...extras,
          id: entry.id || uid(),
          key: $("#dict-key").value,
          type: $("#dict-type").value,
          description: $("#dict-description").value,
          note: $("#dict-note").value,
        };
        project.parameterDictionary ??= [];
        const index = project.parameterDictionary.findIndex(
          (item) => item.id === id,
        );
        if (index < 0) project.parameterDictionary.push(value);
        else project.parameterDictionary[index] = value;
        mark();
        try {
          await save();
        } catch (error) {
          rollbackProjectSave(error, () => {
            project.parameterDictionary = previous;
          });
          throw error;
        }
      },
    );
  }
  on("#builtin-dictionary", "change", (_, element) => {
    project.settings ??= {};
    project.settings.builtinDictionary = element.checked;
    mark();
  });
  on("#new-parameter-entry", "click", () => editParameterEntry());
  on("[data-edit-parameter-entry]", "click", (_, element) =>
    editParameterEntry(element.dataset.editParameterEntry),
  );
  on("[data-delete-parameter-entry]", "click", async (_, element) => {
    if (!confirm("删除字典参数？已应用到接口的参数不变。")) return;
    project.parameterDictionary = project.parameterDictionary.filter(
      (item) => item.id !== element.dataset.deleteParameterEntry,
    );
    mark();
    await save();
  });
  on("[data-save-temporary-parameter]", "click", (_, element) =>
    editParameterEntry(
      undefined,
      (temporaryParameters.get(project.id) || [])[
        Number(element.dataset.saveTemporaryParameter)
      ],
    ),
  );
  on(
    "[data-dictionary-pair], [data-debug-pair-dictionary]",
    "click",
    (_, element) => {
      if (mode === "design") collect();
      const composer = element.dataset.debugPairDictionary;
      const [kind, index] = composer
        ? [composer, undefined]
        : element.dataset.dictionaryPair.split(":");
      const ownerProject = project;
      const ownerRequest = request();
      const ownerRows = ownerRequest[kind];
      modal(
        "选择字典参数",
        `<select id="parameter-choice">${effectiveParameterDictionary(project)
          .map(
            (entry) =>
              `<option value="${esc(entry.id)}">${esc(entry.key)} · ${esc(entry.type)} · ${esc(entry.note || entry.description)}</option>`,
          )
          .join("")}</select>`,
        () => {
          if (
            composer &&
            (project !== ownerProject ||
              request() !== ownerRequest ||
              ownerRequest[kind] !== ownerRows ||
              !ownsDebugPairComposer(kind, page, mode, param))
          )
            throw Error("参数草稿已变化，请重新打开字典");
          const entry = effectiveParameterDictionary(project).find(
            (item) => item.id === $("#parameter-choice").value,
          );
          if (!entry) throw Error("请先添加字典参数");
          const value = dictionaryValue(entry);
          const row = composer
            ? debugPairFromKey(entry.key)
            : request()[kind][Number(index)];
          if (!row) throw Error("字典参数必须包含名称");
          Object.assign(row, {
            key: entry.key,
            value:
              typeof value === "object" ? JSON.stringify(value) : String(value),
            description: entry.description,
            required: entry.required === true,
            schema: {
              type: entry.type,
              ...(entry.enum ? { enum: entry.enum } : {}),
            },
          });
          delete row.schemaDefined;
          if (composer) ownerRows.push(row);
          mark();
          render();
        },
      );
    },
  );
  on("#import-parameter-dictionary", "click", () => {
    const context = previewDraftOwner();
    modal(
      "导入参数字典",
      '<select id="dictionary-format"><option value="kv">key-value</option><option value="json">JSON</option><option value="mysql">MySQL CREATE TABLE</option></select><textarea id="dictionary-source" placeholder="name: 姓名"></textarea>',
      async () => {
        context.assertCurrent();
        const format = $("#dictionary-format").value,
          source = $("#dictionary-source").value;
        const preview = await api(
          "/projects/" + context.owner.id + "/dictionary-preview",
          "POST",
          { format, source },
        );
        context.assertCurrent();
        if (
          $("#dictionary-format").value !== format ||
          $("#dictionary-source").value !== source
        )
          throw Error("导入内容已变化，请重新预览");
        if (
          !Array.isArray(preview) ||
          preview.some(
            (item) =>
              !item?.entry ||
              typeof item.entry.key !== "string" ||
              typeof item.entry.type !== "string",
          )
        )
          throw Error("字典预览结果无效，未写入任何内容");
        modal(
          "确认字典导入",
          "<p>同名同类型的已有项默认不选；源内重复项取信息更完整者。</p>" +
            preview
              .map(
                (item, index) =>
                  `<label><input data-import-parameter="${index}" type="checkbox" ${item.duplicate ? "" : "checked"}>${esc(item.entry.key)} · ${esc(item.entry.type)} · ${item.duplicate ? "已有重复" : "新增"}${item.entry.note ? `<br><small class="muted">${esc(item.entry.note)}</small>` : ""}</label>`,
              )
              .join(""),
          async () => {
            context.assertCurrent();
            const selected = Array.from(
              document.querySelectorAll("[data-import-parameter]:checked"),
              (input) => preview[Number(input.dataset.importParameter)]?.entry,
            );
            if (selected.some((item) => !item))
              throw Error("导入选择无效，请重新预览");
            const previous = context.owner.parameterDictionary;
            context.owner.parameterDictionary = [
              ...(previous || []),
              ...structuredClone(selected),
            ];
            mark();
            try {
              await save();
            } catch (error) {
              rollbackProjectSave(error, () => {
                if (previous === undefined)
                  delete context.owner.parameterDictionary;
                else context.owner.parameterDictionary = previous;
              });
              throw error;
            }
          },
          "导入选中项",
        );
        context.bindDialog();
      },
      "预览",
    );
    context.bindDialog();
  });
  on("[data-dynamic-pair]", "click", (_, element) => {
    collect();
    const [group, index] = element.dataset.dynamicPair.split(":");
    editDynamicValue(group, Number(index));
  });
  function editParameterDescription(index) {
    const existing = project.settings?.parameterDescriptions?.[index];
    modal(
      existing ? "编辑参数说明" : "新增参数说明",
      `<label>参数名</label><input id="description-library-key" maxlength="200" value="${esc(existing?.key || "")}"><label>说明</label><textarea id="description-library-text" maxlength="8000">${esc(existing?.description || "")}</textarea><p class="muted">保存后可在参数定义中明确选择使用，不会自动覆盖现有参数。</p>`,
      async () => {
        const rows = structuredClone(
          project.settings?.parameterDescriptions || [],
        );
        const entry = {
          ...existing,
          key: $("#description-library-key").value,
          description: $("#description-library-text").value,
        };
        if (index === undefined) rows.push(entry);
        else rows[index] = entry;
        validateParameterDescriptions(rows);
        project.settings ??= {};
        const previous = project.settings.parameterDescriptions;
        project.settings.parameterDescriptions = rows;
        mark();
        try {
          await save();
        } catch (error) {
          rollbackProjectSave(error, () => {
            project.settings.parameterDescriptions = previous;
          });
          throw error;
        }
      },
    );
  }
  on("#new-parameter-description", "click", () => editParameterDescription());
  on("[data-edit-parameter-description]", "click", (_, element) =>
    editParameterDescription(Number(element.dataset.editParameterDescription)),
  );
  on("[data-delete-parameter-description]", "click", async (_, element) => {
    if (!confirm("删除此参数说明？已经采用的接口说明不会改变。")) return;
    const previous = project.settings.parameterDescriptions;
    project.settings.parameterDescriptions = previous.filter(
      (_, index) =>
        index !== Number(element.dataset.deleteParameterDescription),
    );
    mark();
    try {
      await save();
    } catch (error) {
      rollbackProjectSave(error, () => {
        project.settings.parameterDescriptions = previous;
      });
      throw error;
    }
  });
  on("[data-define-pair]", "click", (_, element) => {
    if (mode === "design") collect();
    const [kind, index] = element.dataset.definePair.split(":"),
      parameter = request()[kind][Number(index)];
    modal(
      "参数定义",
      `<label>说明</label><input id="parameter-description" value="${esc(parameter.description || "")}">${project.settings?.parameterDescriptions?.length ? parameterDescriptionChoices(project.settings.parameterDescriptions, parameter.key) : ""}<label><input id="parameter-required" type="checkbox" ${parameter.required ? "checked" : ""}>必填</label><label>JSON Schema</label>${jsonEditor(parameter.schema ?? { type: "string" })}`,
      () => {
        parameter.description = $("#parameter-description").value;
        parameter.required = $("#parameter-required").checked;
        parameter.schema = JSON.parse($("#modal-json").value);
        delete parameter.schemaDefined;
        if (parameter.key && parameter.description) {
          const entry = {
            key: parameter.key,
            type: parameter.schema.type || "string",
            description: parameter.description,
            example: parameter.value,
          };
          const values = temporaryParameters.get(project.id) || [];
          if (
            !values.some(
              (item) => item.key === entry.key && item.type === entry.type,
            ) &&
            !(project.parameterDictionary || []).some(
              (item) => item.key === entry.key && item.type === entry.type,
            )
          ) {
            values.push(entry);
            temporaryParameters.set(project.id, values);
          }
        }
        mark();
        render();
      },
    );
    if ($("#apply-parameter-description"))
      $("#apply-parameter-description").onclick = () => {
        const selected = $("#description-choice").value;
        const entry =
          selected === ""
            ? undefined
            : project.settings.parameterDescriptions[Number(selected)];
        if (!entry) {
          toast("请选择参数说明库条目");
          return;
        }
        $("#parameter-description").value = entry.description;
      };
  });
  on("#request-status", "change", (_, element) => {
    request().statusId = element.value;
    mark();
  });
  on("[data-attribute]", "input", (_, element) => {
    validateAttributeDefinitions(project.settings.attributes);
    const field = project.settings.attributes.find(
      (item) => item.key === element.dataset.attribute,
    );
    const value = attributeInputValue(element, field);
    request().attributes ??= {};
    if (value === undefined) delete request().attributes[field.key];
    else request().attributes[field.key] = value;
    mark();
  });
  on("#new-attribute", "click", () => editAttributeDefinition());
  on("[data-edit-attribute-def]", "click", (_, element) =>
    editAttributeDefinition(Number(element.dataset.editAttributeDef)),
  );
  on("[data-delete-attribute-def]", "click", async (_, element) => {
    if (
      !confirm(
        "删除此属性定义？已有原始值会保留，但不会出现在界面或分享文档中。",
      )
    )
      return;
    project.settings.attributes.splice(
      Number(element.dataset.deleteAttributeDef),
      1,
    );
    mark();
    await save();
  });
  on("#new-function", "click", () => editFunction());
  on("[data-edit-function]", "click", (_, element) =>
    editFunction(Number(element.dataset.editFunction)),
  );
  on("[data-delete-function]", "click", async (_, element) => {
    if (
      !confirm(
        "删除函数后，引用它的请求将无法执行。已保存快照不受影响。继续删除？",
      )
    )
      return;
    const previous = [...(project.settings.functions || [])];
    project.settings.functions.splice(
      Number(element.dataset.deleteFunction),
      1,
    );
    mark();
    try {
      await save();
    } catch (error) {
      rollbackProjectSave(error, () => {
        project.settings.functions = previous;
      });
      throw error;
    }
  });
  on("#new-error-code", "click", () => editErrorCode());
  on("[data-edit-error-code]", "click", (_, element) =>
    editErrorCode(Number(element.dataset.editErrorCode)),
  );
  on("[data-delete-error-code]", "click", async (_, element) => {
    if (!confirm("删除此错误码？当前接口文档会同步移除。")) return;
    project.settings.statusCodes.splice(
      Number(element.dataset.deleteErrorCode),
      1,
    );
    mark();
    await save();
  });
  on("#bulk-error-codes", "click", () => {
    const context = previewDraftOwner();
    const source = (project.settings?.statusCodes || [])
      .map((item) => String(item.code) + ": " + JSON.stringify(item.label))
      .join("\n");
    modal(
      "批量编辑错误码",
      '<p>每行 错误码:描述。提交后整体替换字典，未列出的代码会移除。多行说明可使用带引号的 JSON 字符串。</p><textarea id="error-codes-source"></textarea>',
      async () => {
        context.assertCurrent();
        const input = $("#error-codes-source").value;
        const result = await api(
          "/projects/" + context.owner.id + "/error-codes-preview",
          "POST",
          { source: input },
        );
        context.assertCurrent();
        if ($("#error-codes-source").value !== input)
          throw Error("导入内容已变化，请重新预览");
        if (
          !Array.isArray(result?.codes) ||
          result.codes.some(
            (item) =>
              !item ||
              !["string", "number"].includes(typeof item.code) ||
              typeof item.label !== "string",
          )
        )
          throw Error("错误码预览结果无效，未写入任何内容");
        const previous = project.settings?.statusCodes || [];
        project.settings ??= {};
        project.settings.statusCodes = result.codes.map((item) => ({
          ...item,
          httpHint:
            previous.find((old) => String(old.code) === String(item.code))
              ?.httpHint === true,
        }));
        mark();
        try {
          await save();
        } catch (error) {
          rollbackProjectSave(error, () => {
            project.settings.statusCodes = previous;
          });
          throw error;
        }
      },
    );
    context.bindDialog();
    $("#error-codes-source").value = source;
  });
  on("#mock-builtins", "change", (_, element) => {
    project.settings ??= {};
    project.settings.smartMockBuiltins = element.checked;
    mark();
  });
  on("#mock-seed", "input", (_, element) => {
    project.settings ??= {};
    project.settings.mockSeed = Number(element.value);
    mark();
  });
  on("#new-mock-field", "click", () => editMockField());
  on("[data-edit-mock-field]", "click", (_, element) =>
    editMockField(element.dataset.editMockField),
  );
  on("[data-mock-field-enabled]", "change", (_, element) => {
    project.settings.mockFieldRules.find(
      (rule) => rule.id === element.dataset.mockFieldEnabled,
    ).enabled = element.checked;
    mark();
  });
  on("[data-delete-mock-field]", "click", async (_, element) => {
    if (!confirm("删除这条字段生成规则？已有请求体不会改变。")) return;
    project.settings.mockFieldRules = project.settings.mockFieldRules.filter(
      (rule) => rule.id !== element.dataset.deleteMockField,
    );
    mark();
    await save();
  });
  on("#recursive-folder-scopes", "change", (_, element) => {
    if (
      element.checked &&
      !confirm(
        "开启后，祖先目录的参数、认证和脚本将用于后代接口。请确认这些接口的目标可信；已有计划和用例快照不变。继续？",
      )
    ) {
      element.checked = false;
      return;
    }
    project.settings ??= {};
    project.settings.recursiveFolderScopes = element.checked;
    mark();
  });
  on("#script-url-mode", "change", (_, element) => {
    const previous = request().scriptURLMode || "string";
    if (!confirm(scriptURLModeNotice + " 确认切换？")) {
      element.value = previous;
      return;
    }
    if (element.value === "sdk") request().scriptURLMode = "sdk";
    else delete request().scriptURLMode;
    delete request().scriptURLRuntime;
    mark();
  });
  on("#script-dialect", "change", (_, element) => {
    const previous = request().scriptDialect || "legacy";
    if (!confirm(scriptDialectNotice + " 确认切换？")) {
      element.value = previous;
      return;
    }
    request().scriptDialect = element.value;
    mark();
  });
  on("#inherit-shared-scripts", "change", (_, element) => {
    request().inheritSharedScripts = element.checked;
    mark();
  });
  const editableSharedScripts = () => {
    project.settings ??= {};
    const folder = $("#parameter-scope")?.value || "";
    const map = folder
      ? (project.settings.folderScripts ??= {})
      : project.settings;
    const key = folder || "globalScripts";
    if (!Object.hasOwn(map, key))
      Object.defineProperty(map, key, {
        value: { enabled: false, beforeScript: "", afterScript: "" },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    return map[key];
  };
  on("#shared-scripts-enabled", "change", (_, element) => {
    editableSharedScripts().enabled = element.checked;
    mark();
  });
  on("[data-shared-script]", "input", (_, element) => {
    editableSharedScripts()[element.dataset.sharedScript] = element.value;
    mark();
  });
  on("#inherit-auth", "change", (_, element) => {
    request().inheritAuth = element.checked;
    mark();
  });
  const sharedAuthTarget = () => {
    project.settings ??= {};
    const folder = $("#parameter-scope")?.value || "";
    return folder
      ? { map: (project.settings.folderAuth ??= {}), key: folder }
      : { map: project.settings, key: "globalAuth" };
  };
  on("#shared-auth-enabled", "change", (_, element) => {
    const { map, key } = sharedAuthTarget();
    if (element.checked)
      Object.defineProperty(map, key, {
        value: { type: "none" },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    else delete map[key];
    mark();
    render();
  });
  on("#shared-auth-type", "change", (_, element) => {
    const { map, key } = sharedAuthTarget();
    map[key] = { type: element.value };
    mark();
    render();
  });
  on("[data-shared-auth]", "input", (_, element) => {
    const { map, key } = sharedAuthTarget();
    map[key][element.dataset.sharedAuth] = element.value;
    mark();
  });
  on("#parameter-scope", "change", (_, element) => {
    parameterScopes.set(project.id, element.value);
    render();
  });
  const editableParameters = () => {
    project.settings ??= {};
    const folder =
      $("#parameter-scope")?.value ?? parameterScopes.get(project.id);
    if (!folder) return (project.settings.globalParameters ??= {});
    const folders = (project.settings.folderParameters ??= {});
    if (!Object.hasOwn(folders, folder))
      Object.defineProperty(folders, folder, {
        value: {},
        enumerable: true,
        configurable: true,
        writable: true,
      });
    return folders[folder];
  };
  on("[data-global-add]", "click", (_, element) => {
    (editableParameters()[element.dataset.globalAdd] ??= []).push({
      key: "",
      value: "",
      enabled: true,
    });
    mark();
    render();
  });
  on("[data-global-field]", "input", (_, element) => {
    const [kind, index, field] = element.dataset.globalField.split(":");
    editableParameters()[kind][index][field] = element.value;
    mark();
  });
  on("[data-global-enabled]", "change", (_, element) => {
    const [kind, index] = element.dataset.globalEnabled.split(":");
    editableParameters()[kind][index].enabled = element.checked;
    mark();
  });
  on("[data-global-remove]", "click", (_, element) => {
    const [kind, index] = element.dataset.globalRemove.split(":");
    editableParameters()[kind].splice(Number(index), 1);
    mark();
    render();
  });
  on("#cookie-encoding", "change", (_, element) => {
    request().cookieEncoding = element.value;
    mark();
  });
  on("#query-add-equal", "change", (_, element) => {
    request().queryAddEqual = element.checked;
    if (element.closest(".debug-query-equality"))
      element.title = debugQueryEqualityLabel(element.checked);
    mark();
  });
  on("#inherit-global-parameters", "change", (_, element) => {
    request().inheritGlobalParameters = element.checked;
    mark();
  });
  on("[data-settings-anchor]", "click", (_, element) => {
    collect();
    settingsSection = element.dataset.settingsAnchor;
    render();
  });
  on("[data-edit-resource]", "click", (_, element) => {
    const key = element.dataset.editResource,
      spec = resources[key];
    modal(
      "编辑" + spec.name,
      `<p>${esc(spec.help)}</p><details><summary>示例格式</summary><pre>${esc(JSON.stringify(spec.sample, null, 2))}</pre></details>${jsonEditor(project.settings?.[key] || [])}`,
      async () => {
        const value = JSON.parse($("#modal-json").value);
        if (!Array.isArray(value)) throw Error("资源必须是数组");
        if (key === "attributes") {
          validateAttributeDefinitions(value);
          for (const record of [...project.requests, ...project.documents])
            validateAttributeValues(record.attributes, value);
        }
        const previous = project.settings?.[key];
        project.settings ??= {};
        project.settings[key] = value;
        mark();
        try {
          await save();
        } catch (error) {
          rollbackProjectSave(error, () => {
            project.settings[key] = previous;
          });
          throw error;
        }
        render();
      },
    );
  });
  on("#request-service", "change", (_, e) => {
    request().serviceId = e.value;
    request().serviceSnapshot = false;
    mark();
  });
  on("#schema", "input", () => mark());
  on("#schema", "change", (_, e) => {
    request().schema = JSON.parse(e.value);
    mark();
  });
  on("[data-mode]", "click", (event, e) => {
    const fromKeyboard = event.detail === 0 && e === document.activeElement;
    collect();
    mode = e.dataset.mode;
    render();
    if (fromKeyboard) $('.request-modes [aria-pressed="true"]')?.focus();
  });
  const selectDesignParameter = (key) => {
    if (key === designParameter) return;
    collect();
    const top = $(".http-design-canvas")?.scrollTop || 0;
    const left = $(".design-parameter-tabs")?.scrollLeft || 0;
    designParameter = key;
    bodyGenerationSequence++;
    render();
    $(".http-design-canvas").scrollTop = top;
    $(".design-parameter-tabs").scrollLeft = left;
    $("#design-tab-" + key)?.focus();
  };
  on("[data-design-parameter]", "click", (_, e) =>
    selectDesignParameter(e.dataset.designParameter),
  );
  on("[data-design-parameter]", "keydown", (event, e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = designParameterTabs.findIndex(
      ([key]) => key === e.dataset.designParameter,
    );
    const size = designParameterTabs.length;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? size - 1
          : (index + (event.key === "ArrowRight" ? 1 : size - 1)) % size;
    selectDesignParameter(designParameterTabs[next][0]);
  });
  on("[data-param]", "click", (_, e) => {
    collect();
    param = e.dataset.param;
    render();
  });
  on("[data-response]", "click", (_, e) => {
    responseTab = e.dataset.response;
    render();
  });
  on("#body-code", "input", (_, element) => {
    if ($("#code-highlight"))
      $("#code-highlight").innerHTML = highlightJSON(element.value) + "\n";
    if ($("#code-gutter"))
      $("#code-gutter").textContent = element.value
        .split("\n")
        .map((_, index) => index + 1)
        .join("\n");
  });
  on("#body-code", "scroll", (_, element) => {
    if ($("#code-highlight")) {
      $("#code-highlight").scrollTop = element.scrollTop;
      $("#code-highlight").scrollLeft = element.scrollLeft;
    }
    if ($("#code-gutter")) $("#code-gutter").scrollTop = element.scrollTop;
  });
  on('input[name="body-type"],#raw-format', "change", (_, e) => {
    const restoreEmptyBodyRadio =
      mode === "debug" &&
      e.name === "body-type" &&
      e.matches(":focus-visible") &&
      (e.value === "none" ||
        e.closest(".request-panel")?.querySelector(":scope > .body-none"));
    collect();
    if (["none", "form-data", "urlencoded"].includes(e.value))
      bodyExpanded = false;
    if (e.name === "body-type" && e.value === "raw" && !$("#raw-format"))
      request().bodyType = "json";
    mark();
    render();
    if (restoreEmptyBodyRadio)
      $('input[name="body-type"]:checked')?.focus({ preventScroll: true });
  });
  on("#expand-body", "click", () => {
    collect();
    bodyExpanded = !bodyExpanded;
    render();
    $("#body-code")?.focus();
  });
  on("#toggle-parameter-helper", "click", () => {
    collect();
    helperOpen = !helperOpen;
    render();
  });
  on("#new-body-dynamic", "click", () => editDynamicValue("body"));
  on("[data-edit-body-dynamic]", "click", (_, element) =>
    editDynamicValue("body", element.dataset.editBodyDynamic),
  );
  on("#insert-builtin-variable", "click", () => {
    const name = $("#builtin-variable").value;
    insertVariable(name);
    if ($("#builtin-variable")) $("#builtin-variable").value = name;
  });
  on("[data-insert-variable]", "click", (_, element) => {
    insertVariable(element.dataset.insertVariable);
  });
  on("[data-insert-dictionary]", "click", (_, element) => {
    collect();
    const entry = effectiveParameterDictionary(project).find(
      (item) => item.id === element.dataset.insertDictionary,
    );
    if (!entry) throw Error("字典参数已不存在");
    request().body = insertDictionaryField(request().body, entry);
    request().bodyType = "json";
    mark();
    render();
  });
  on("#generate-body", "click", async () => {
    collect();
    const targetProject = project,
      targetRequest = request(),
      version = editVersion,
      openingSequence = projectOpenSequence,
      generation = ++bodyGenerationSequence,
      targetPage = page,
      targetMode = mode;
    if (!targetProject || !targetRequest) throw Error("请先选择接口");
    const data = await api(
      "/projects/" + targetProject.id + "/sample",
      "POST",
      {
        schema: structuredClone(targetRequest.schema),
      },
    );
    if (
      generation !== bodyGenerationSequence ||
      project !== targetProject ||
      request() !== targetRequest ||
      editVersion !== version ||
      projectOpenSequence !== openingSequence ||
      page !== targetPage ||
      mode !== targetMode
    )
      throw Error("接口、项目或草稿已变化，未应用生成结果；当前内容仍保留");
    targetRequest.body = JSON.stringify(data.sample, null, 2);
    targetRequest.bodyType = "json";
    mark();
    render();
  });
  on("#format-json", "click", (event, button) => {
    const debugRawJSON = Boolean(button.closest(".http-debug-raw-actions"));
    const keepFocus =
      debugRawJSON && event.detail === 0 && button === document.activeElement;
    collect();
    request().body = JSON.stringify(
      JSON.parse(request().body),
      null,
      debugRawJSON ? 4 : 2,
    );
    mark();
    render();
    if (keepFocus) $("#format-json")?.focus({ preventScroll: true });
  });
  on("[data-field-type]", "change", (_, e) => {
    request().form[e.dataset.fieldType].type = e.value;
    delete request().form[e.dataset.fieldType].schemaDefined;
    mark();
    render();
  });
  on("[data-field-file]", "change", async (_, e) => {
    const file = e.files[0];
    const selectedProject = project;
    const selectedRequest = request();
    const index = Number(e.dataset.fieldFile);
    const field = selectedRequest?.form[index];
    const selectedBodyType = selectedRequest?.bodyType;
    await applySelectedFormFile(
      file,
      field,
      () =>
        page === "apis" &&
        project === selectedProject &&
        request() === selectedRequest &&
        selectedRequest.bodyType === selectedBodyType &&
        selectedRequest.form[index] === field &&
        field.type === "file",
      () => {
        mark();
        render();
      },
    );
  });
  on("[data-pair]", "input", (_, e) => {
    const [k, i, f] = e.dataset.pair.split(":");
    request()[k][i][f] = e.value;
    if (f === "key") delete request()[k][i].schemaDefined;
    mark();
  });
  on("[data-pair-enabled]", "change", (_, e) => {
    const [k, i] = e.dataset.pairEnabled.split(":");
    request()[k][i].enabled = e.checked;
    mark();
  });
  const composerProject = project;
  const composerRequest = request();
  const commitDebugPair = (event, input) => {
    const kind = input.dataset.debugPairName;
    if (
      event.isComposing ||
      !input.isConnected ||
      project !== composerProject ||
      request() !== composerRequest ||
      !ownsDebugPairComposer(kind, page, mode, param)
    )
      return;
    const row = debugPairFromKey(input.value);
    if (!row) return;
    const rows = composerRequest[kind];
    const index = rows.length;
    const { selectionStart, selectionEnd, selectionDirection } = input;
    rows.push(row);
    mark();
    render();
    const next = $(`[data-pair="${kind}:${index}:key"]`);
    next?.focus({ preventScroll: true });
    if (selectionStart !== null && selectionEnd !== null)
      next?.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
  };
  on("[data-debug-pair-name]", "input", commitDebugPair);
  on("[data-debug-pair-name]", "compositionend", commitDebugPair);
  on("[data-add-pair]", "click", (_, e) => {
    if (mode === "design") collect();
    const key = e.dataset.addPair;
    if (ownsDebugPairComposer(key, page, mode, param)) {
      $(`[data-debug-pair-name="${key}"]`)?.focus();
      return;
    }
    const index = request()[key].length;
    request()[key].push({ key: "", value: "", enabled: true });
    mark();
    render();
    if (mode === "design") $(`[data-pair="${key}:${index}:key"]`)?.focus();
  });
  on("[data-remove-pair]", "click", (_, e) => {
    if (mode === "design") collect();
    const [k, i] = e.dataset.removePair.split(":");
    request()[k].splice(Number(i), 1);
    mark();
    render();
  });
  on("#auth-type", "change", (_, e) => {
    if (e.hasAttribute("data-debug-auth-choice")) {
      const r = request();
      if (!usesDebugAuthChoice(project, r) || mode !== "debug") return;
      const drafts = debugAuthDrafts.get(r) || new Map();
      const focused = document.activeElement === e;
      try {
        if (!updateDebugAuthChoice(r, e.value, drafts)) return;
      } catch (error) {
        e.value = debugAuthChoice(r);
        throw error;
      }
      debugAuthDrafts.set(r, drafts);
      mark();
      render();
      if (focused) $("#auth-type")?.focus({ preventScroll: true });
      return;
    }
    if (mode === "design") {
      try {
        collect();
      } catch (error) {
        e.value = request().auth.type;
        throw error;
      }
    }
    const focused = document.activeElement === e;
    request().auth.type = e.value;
    mark();
    render();
    if (focused) $("#auth-type")?.focus({ preventScroll: true });
  });
  on("[data-auth]", "input", (_, e) => {
    request().auth[e.dataset.auth] = e.value;
    mark();
  });
  on("#expand-script", "click", () => {
    collect();
    const draft = createScriptDraft(project, request(), param);
    modal(
      (param === "before" ? "前置" : "后置") + "脚本编辑器",
      `<p class="muted">这是临时草稿。应用只更新当前接口，不执行脚本、不自动保存项目；取消或 Esc 放弃本次编辑。</p><label for="expanded-script-code">JavaScript</label><textarea id="expanded-script-code" wrap="off" spellcheck="false">${esc(draft.text)}</textarea>`,
      () => {
        if (
          applyScriptDraft(
            draft,
            project,
            request(),
            param,
            $("#expanded-script-code").value,
          )
        ) {
          mark();
          render();
        }
      },
      "应用到接口",
    );
    $("#expanded-script-code").focus();
    $("#dialog").addEventListener(
      "close",
      () => {
        if (
          project === draft.project &&
          request() === draft.request &&
          param === draft.stage
        )
          $("#expand-script")?.focus();
      },
      { once: true },
    );
  });
  on("#script-code", "input", (_, element) => {
    request()[param + "Script"] = element.value;
    mark();
  });
  on("#oauth1-get", "click", async (_, button) => {
    collect();
    const requestId = current,
      projectId = project.id,
      config = structuredClone(request().auth),
      original = JSON.stringify(request().auth);
    const ownsAuth = $("#auth-type[data-debug-auth-choice]")
      ? captureDebugAuthOperation(project, request())
      : null;
    const pendingKey = projectId + ":" + requestId;
    if (pendingOAuth1.has(pendingKey)) return;
    pendingOAuth1.add(pendingKey);
    button.disabled = true;
    try {
      if (
        !confirm(
          "将向填写的OAuth1端点请求临时令牌，并在你授权后交换访问令牌。请确认端点可信；获取后不会自动保存到磁盘。继续？",
        )
      )
        return;
      const flow = await api("/oauth1/start", "POST", config);
      if (project.id !== projectId || current !== requestId)
        throw Error("项目/接口已切换，请重新开始OAuth1授权");
      if (ownsAuth && !ownsAuth(project, request()))
        throw Error("原接口认证已变化，请重新授权");
      modal(
        "OAuth1 OOB/PIN 授权",
        `<p><a href="${esc(flow.authorizationUrl)}" target="_blank" rel="noopener noreferrer">打开服务授权页面</a></p><p>在服务页面授权后复制验证码。流程5分钟后过期；临时令牌密钥仅保留在内存。</p><label>Verifier / PIN</label><input id="oauth1-verifier" autocomplete="off">`,
        async () => {
          const target =
            project.id === projectId &&
            project.requests.find((item) => item.id === requestId);
          if (
            !target ||
            JSON.stringify(target.auth) !== original ||
            (ownsAuth && !ownsAuth(project, target))
          )
            throw Error("原接口认证已变化，请重新授权，避免覆盖修改");
          const result = await api("/oauth1/complete", "POST", {
            id: flow.id,
            verifier: $("#oauth1-verifier").value,
          });
          if (
            project.id !== projectId ||
            JSON.stringify(target.auth) !== original
          )
            throw Error("项目或认证已变化，令牌未写入");
          const currentTarget = project.requests.find(
            (item) => item.id === requestId,
          );
          if (
            !currentTarget ||
            JSON.stringify(currentTarget.auth) !== original ||
            (ownsAuth && !ownsAuth(project, currentTarget))
          )
            throw Error("接口已更新，令牌未覆盖现有修改");
          currentTarget.auth.accessToken = result.accessToken;
          currentTarget.auth.tokenSecret = result.tokenSecret;
          mark();
          render();
          toast("OAuth1令牌已获取，尚未保存到磁盘");
        },
        "交换访问令牌",
      );
    } finally {
      pendingOAuth1.delete(pendingKey);
      if (button.isConnected) button.disabled = false;
    }
  });
  on("#oauth-get", "click", async () => {
    const requestId = current,
      projectId = project.id;
    const config = structuredClone(request().auth);
    const ownsAuth = $("#auth-type[data-debug-auth-choice]")
      ? captureDebugAuthOperation(project, request())
      : null;
    const applyToken = (result) => {
      if (project.id !== projectId)
        throw Error("项目已切换，令牌未写入其他项目");
      const target = project.requests.find((item) => item.id === requestId);
      if (!target) throw Error("原请求已不存在");
      if (ownsAuth && !ownsAuth(project, target))
        throw Error("原接口认证已变化，令牌未覆盖现有修改");
      target.auth.token = result.accessToken;
      if (result.refreshToken) target.auth.refreshToken = result.refreshToken;
      mark();
      render();
      toast("OAuth 令牌已获取，尚未保存到磁盘");
    };
    if (config.grantType === "authorization_code") {
      const flow = await api("/oauth/start", "POST", config);
      if (ownsAuth && !ownsAuth(project, request()))
        throw Error("原接口认证已变化，请重新授权");
      modal(
        "OAuth 授权",
        `<p>请先在身份提供方登记此回调地址：</p><pre>${esc(flow.redirectUri)}</pre><p><a href="${esc(flow.authorizationUrl)}" target="_blank" rel="noopener noreferrer">打开授权页面</a></p><p>授权结束后返回这里检查结果。流程 5 分钟后过期。</p>`,
        async () => {
          const status = await api("/oauth/status/" + flow.id);
          if (status.status === "error") throw Error(status.error);
          if (status.status !== "completed") throw Error("授权尚未完成");
          applyToken(status.result);
        },
        "检查授权结果",
      );
    } else applyToken(await api("/oauth/token", "POST", config));
  });
  on("#edit-operations", "click", editRules);
  on("#add-assertion", "click", () => {
    request().assertions.push({ target: "status", op: "eq", value: 200 });
    mark();
    render();
  });
  on("[data-rule]", "change", (_, e) => {
    const [i, key] = e.dataset.rule.split(":");
    let value = e.value;
    if (key === "value") {
      try {
        value = JSON.parse(value);
      } catch {}
    }
    request().assertions[i][key] = value;
    mark();
  });
  on("[data-remove-rule]", "click", (_, e) => {
    request().assertions.splice(Number(e.dataset.removeRule), 1);
    mark();
    render();
  });
  on("#add-extract", "click", () => {
    request().extract.push({ name: "token", path: "$.token" });
    mark();
    render();
  });
  on("[data-extract]", "input", (_, e) => {
    const [i, key] = e.dataset.extract.split(":");
    request().extract[i][key] = e.value;
    mark();
  });
  on("[data-remove-extract]", "click", (_, e) => {
    request().extract.splice(Number(e.dataset.removeExtract), 1);
    mark();
    render();
  });
  on(".http-action-split details", "keydown", (event, details) => {
    if (event.key !== "Escape" || !details.open) return;
    event.preventDefault();
    event.stopPropagation();
    details.open = false;
    details.querySelector("summary").focus();
  });
  on("#send-menu-curl", "click", (_, element) => {
    const details = element.closest("details");
    details.open = false;
    details.querySelector("summary").focus();
    $("#curl").click();
  });
  on("#send-menu-plan", "click", () => {
    mode = "cases";
    render();
    $("#create-case").click();
  });
  on("#save-menu-copy", "click", () => $("#duplicate").click());
  on("#save-menu-project", "click", () => save());
  on("#duplicate", "click", () => {
    collect();
    const r = structuredClone(request());
    r.id = uid();
    r.name += " 副本";
    project.requests.push(r);
    current = r.id;
    response = null;
    if (!opened.includes(current)) opened.push(current);
    mark();
    render();
  });
  on("#delete", "click", async () => {
    if (project.settings?.nativeInheritance) {
      await changeNativeRequestLifecycle(request().id, false);
      return;
    }
    if (!confirm("将此接口移到回收站？")) return;
    request().deletedAt = new Date().toISOString();
    current = project.requests.find((r) => !r.deletedAt)?.id;
    response = responses.get(project.id + ":" + current) || null;
    mark();
    render();
  });
  on("[data-restore]", "click", async (_, e) => {
    if (project.settings?.nativeInheritance) {
      await changeNativeRequestLifecycle(e.dataset.restore, true);
      return;
    }
    delete project.requests.find((r) => r.id === e.dataset.restore).deletedAt;
    mark();
    await save();
  });
  on("#send", "click", send);
  const cancelForegroundRun = () =>
    runId ? api("/cancel", "POST", { id: runId }) : undefined;
  on("#cancel", "click", () => {
    if (!caseCancellationOwner()) return cancelForegroundRun();
  });
  on("#cancel-case-run", "click", () => {
    if (!canCancelCurrentCase()) return;
    if (caseBatch?.running) caseBatch.cancelRequested = true;
    return cancelForegroundRun();
  });
  on("#download-response-binary", "click", () => {
    const bytes = Uint8Array.from(atob(response.rawBodyBase64), (character) =>
      character.charCodeAt(0),
    );
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/octet-stream" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "response.bin";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  on("#curl", "click", async () => {
    collect();
    const r = await api("/projects/" + project.id + "/curl", "POST", {
      request: request(),
      environmentId: env(),
    });
    modal(
      "cURL（Bash）",
      `<p class="muted">按当前环境生成，不执行前后置脚本。可能包含认证凭据，请勿公开分享。HTTP/2命令需要支持HTTP/2的cURL；HTTPS严格HTTP/2需cURL8.10或更新版。</p><textarea id="curl-output" readonly>${esc(r.curl)}</textarea>`,
      () => navigator.clipboard.writeText(r.curl),
      "复制",
    );
  });
  on("#import", "click", () =>
    modal(
      "导入接口",
      `<p class="muted">支持项目JSON、OpenAPI JSON/YAML、Postman Collection、cURL及Apipost旧版/现代JSON（有限兼容）。现代JSON同时导入环境、服务和全局变量，遇到未支持资源会拒绝；请选择导入环境后再发送。仅解析，不执行导入内容。</p><label>导入方式</label><select id="import-mode"><option value="interfaces">导入接口到当前项目</option><option value="restore">完整恢复项目备份为新副本</option><option value="apipost-directory">原版目录JSON子集（实验性，非完整迁移）</option></select><input id="import-file" type="file" accept=".json,.yaml,.yml,.txt"><textarea id="import-text" placeholder="粘贴 JSON 或 cURL"></textarea><label>仅原版目录模式使用：选择含 project.json 的目录，未知文件会拒绝</label><input id="import-directory" type="file" webkitdirectory multiple aria-label="原版项目目录">`,
      async () => {
        if (busy || saving) throw Error("请先结束当前请求或保存，再导入");
        nativeRequestLifecycle.assertCanSave(project.id);
        nativeRequestLifecycle.reloadCheckpoint();
        const targetProjectId = project.id,
          importRevision = modalRevision,
          importMode = $("#import-mode").value,
          selectedFile = $("#import-file").files[0],
          selectedText = $("#import-text").value,
          directoryFiles = Array.from($("#import-directory").files);
        const inputChanged = () =>
          project.id !== targetProjectId ||
          modalRevision !== importRevision ||
          !$("#dialog").open ||
          $("#import-mode")?.value !== importMode ||
          $("#import-file")?.files[0] !== selectedFile ||
          $("#import-text")?.value !== selectedText ||
          (importMode === "apipost-directory" &&
            (Array.from($("#import-directory")?.files || []).length !==
              directoryFiles.length ||
              directoryFiles.some(
                (file, index) => $("#import-directory").files[index] !== file,
              )));
        const operation = projectImports.begin(targetProjectId, importMode);
        let posted = false,
          result;
        try {
          collect();
          if (dirty) {
            if (!confirm("当前有未保存修改，先保存再导入？"))
              throw Error("导入已取消，修改仍保留");
            await operation.saveDraft(save);
          }
          if (inputChanged() || dirty || busy || saving)
            throw Error("项目、草稿或导入内容已变化，未执行导入");
          const targetProject = project,
            version = editVersion,
            openingSequence = projectOpenSequence;
          const stopped = () =>
            inputChanged() ||
            project !== targetProject ||
            editVersion !== version ||
            projectOpenSequence !== openingSequence ||
            dirty ||
            busy ||
            saving;
          const document =
            importMode === "apipost-directory"
              ? await selectedDirectoryDocument(directoryFiles, {
                  shouldStop: stopped,
                })
              : selectedFile
                ? await selectedFile.text()
                : selectedText;
          if (stopped()) throw Error("项目、草稿或导入内容已变化，未执行导入");
          const body = {
            document:
              importMode === "restore" && typeof document === "string"
                ? JSON.parse(document)
                : document,
          };
          posted = true;
          result = await api(
            importMode === "restore"
              ? "/restore"
              : "/projects/" + targetProjectId + "/import",
            "POST",
            body,
          );
          if (stopped())
            throw Error("导入返回时项目或草稿已变化，未替换当前内容");
          if (importMode === "restore") {
            if (!result?.id || result.id === targetProjectId)
              throw Error("恢复返回的项目身份无效");
            operation.finish();
            const list = await api("/projects");
            if (stopped())
              throw Error("恢复完成后项目或草稿已变化，未切换当前内容");
            projects = list;
            await openProject(result.id);
          } else {
            if (result?.id !== targetProjectId)
              throw Error("导入返回的项目身份不匹配");
            project = result;
            dirty = false;
            current = project.requests.at(-1)?.id;
            activeDocumentId = null;
            response = null;
            if (current && !opened.includes(current)) opened.push(current);
            if (request()?.importNotes?.length) {
              page = "apis";
              mode = "design";
            }
            render();
          }
          toast(
            request()?.importNotes?.length
              ? "导入完成，请确认导入提示"
              : "导入完成",
          );
        } catch (error) {
          if (posted) {
            operation.requireReconciliation();
            throw Error(
              error.message +
                (importMode === "restore"
                  ? "。恢复可能已创建副本，请刷新页面检查项目列表，勿直接重复恢复；当前草稿仍保留。"
                  : "。导入可能已写入原项目，请重新加载核对，勿重复导入；当前草稿仍保留，请先复制需要保留的修改。"),
            );
          }
          throw error;
        } finally {
          operation.finish();
        }
      },
    ),
  );
  on("#export", "click", () => {
    modal(
      "导出项目",
      '<button id="scoped-export-open">选择资源导出定义（预览范围和依赖）</button><hr><p>以下为整项目导出；本地项目 JSON 是完整备份，包含环境及历史。</p><label>整项目格式</label><select id="export-format"><option value="native">本地项目 JSON（包含环境和历史）</option><option value="openapi">OpenAPI 3 JSON（接口定义）</option></select><p class="notice">导出内容可能包含密钥、请求凭据和响应数据，请检查后再分享。</p>',
      async () => {
        await save();
        const format = $("#export-format").value;
        const data = await api(
          "/projects/" + project.id + "/export?format=" + format,
        );
        download(project.name + "." + format + ".json", data);
      },
      "导出",
    );
    $("#scoped-export-open").onclick = () => {
      try {
        openScopedDefinitionExport();
      } catch (error) {
        toast(error.message);
      }
    };
  });
  on("#locate-request", "click", () => {
    collect();
    const doc = workspaceDocument();
    const selected = doc || request();
    if (!selected || selected.deletedAt)
      throw Error("没有当前接口或文档可定位");
    search = "";
    searchType = "all";
    const selectedPath = selected.folder || "";
    for (const key of [...collapsedFolders]) {
      const folder = key.slice((project.id + ":").length);
      if (
        key.startsWith(project.id + ":") &&
        (selectedPath === folder || selectedPath.startsWith(folder + "/"))
      )
        collapsedFolders.delete(key);
    }
    page = "apis";
    render();
    const item = doc
      ? $('[data-document-index="' + project.documents.indexOf(doc) + '"]')
      : $('[data-request="' + CSS.escape(current) + '"]');
    item?.scrollIntoView({ block: "nearest" });
    item?.focus({ preventScroll: true });
  });
  on("#tree-type", "change", (_, element) => {
    searchType = element.value;
    $("#tree").innerHTML = tree();
    bindTree();
  });
  on("#save-protocol", "click", async () => {
    const item = {
      id: selectedProtocolId || uid(),
      name: $("#protocol-name").value || "新连接",
      type: $("#protocol-type").value,
      url: $("#protocol-url").value,
      port: Number($("#protocol-port").value),
    };
    project.protocols ??= [];
    const index = project.protocols.findIndex(
      (existing) => existing.id === item.id,
    );
    if (index < 0) project.protocols.push(item);
    else project.protocols[index] = item;
    selectedProtocolId = item.id;
    mark();
    await save();
  });
  on("#delete-protocol", "click", async () => {
    if (!selectedProtocolId) throw Error("请从目录选择已保存的连接");
    if (!confirm("删除连接定义？当前连接不会因此断开。")) return;
    project.protocols = (project.protocols || []).filter(
      (item) => item.id !== selectedProtocolId,
    );
    selectedProtocolId = "";
    mark();
    await save();
  });
  on("#session-connect", "click", () =>
    sessionController.connect({
      type: $("#protocol-type").value,
      url: $("#protocol-url").value,
      host: $("#protocol-url").value,
      port: Number($("#protocol-port").value),
    }),
  );
  on("#session-send", "click", () =>
    sessionController.send($("#protocol-message").value),
  );
  on("#session-stop", "click", () => sessionController.stop());
  on("#session-refresh", "click", () => sessionController.poll());
  on("#session-export", "click", () => {
    if (!sessionController.status().intentId) throw Error("没有会话或恢复证据");
    download("protocol-session.json", sessionController.evidence());
  });
  on("#protocol-run", "click", async () => {
    assertExecutionReady();
    runId = uid();
    busy = true;
    $("#protocol-run").disabled = true;
    try {
      const type = $("#protocol-type").value;
      const result = await api(
        "/projects/" + project.id + "/protocol",
        "POST",
        {
          type,
          url: $("#protocol-url").value,
          host: $("#protocol-url").value,
          port: Number($("#protocol-port").value),
          duration: Number($("#protocol-duration").value),
          message: $("#protocol-message").value,
          runId,
        },
      );
      $("#protocol-result").textContent = JSON.stringify(result, null, 2);
    } finally {
      busy = false;
      if ($("#protocol-run")) $("#protocol-run").disabled = false;
    }
  });
  on("#db-register", "click", () => {
    const projectId = project.id;
    const type = $("#db-type").value;
    const connection = isPreviewDatabase(type)
      ? readDatabasePreviewConnection($("#db-type"), $, type)
      : {
          type,
          filename: $("#db-path").value,
          host: $("#db-host").value,
          port:
            type === "mysql"
              ? mysqlPortInput($("#db-port").value)
              : type === "mongodb"
                ? mongoPortInput($("#db-port").value)
                : Number($("#db-port").value),
          user: $("#db-user").value,
          password: $("#db-password").value,
          database: $("#db-name").value,
          ssl: $("#db-tls").checked,
          ca: $("#db-tls").checked ? $("#db-ca").value : "",
          authSource: $("#db-auth-source").value,
        };
    if (isPreviewDatabase(type)) {
      $("#db-password").value = "";
      $("#db-client-key").value = "";
    }
    modal(
      "授权数据库会话连接",
      '<label>连接名称</label><input id="db-connection-name" value="调试数据库"><p class="notice">授权后，此项目的接口、用例和手动执行计划可使用此连接进行只读前后置查询，查询结果可进入变量、HTTP请求及历史。仅连接可信数据库；自定义函数仍可能有副作用。连接信息仅存本次应用进程内存，不写入项目或导出；重启后需重新授权。MCP、CLI和压测不获得该权限。</p>',
      async () => {
        if (project.id !== projectId) throw Error("项目已切换，请重新操作");
        await api("/projects/" + projectId + "/database-connections", "POST", {
          ...connection,
          name: $("#db-connection-name").value,
        });
        toast("已授权本项目会话连接，重启后失效");
      },
      "确认授权",
    );
  });
  on("#db-connections", "click", async () => {
    const projectId = project.id;
    const connections = await api(
      "/projects/" + projectId + "/database-connections",
    );
    if (project.id !== projectId) return;
    modal(
      "本项目数据库会话连接",
      connections.length
        ? connections
            .map(
              (item) =>
                "<p>" +
                esc(item.name) +
                " · " +
                esc(item.type) +
                ' <button type="button" data-revoke-db="' +
                esc(item.id) +
                '">撤销</button></p>',
            )
            .join("")
        : "<p>没有已授权连接。重启后需要重新配置。</p>",
      () => {},
    );
    for (const button of $("#dialog-content").querySelectorAll(
      "[data-revoke-db]",
    ))
      button.onclick = async () => {
        button.disabled = true;
        try {
          await api(
            "/projects/" + projectId + "/database-connections",
            "DELETE",
            { id: button.dataset.revokeDb },
          );
          button.closest("p").textContent =
            "已撤销；运行中的结果不会再应用，后续操作会明确失败。";
        } catch (error) {
          toast(error.message, true);
          button.disabled = false;
        }
      };
  });
  let databaseDialogOpening = false;
  const databaseOperationDialog = async (index = -1) => {
    if (databaseDialogOpening) return;
    databaseDialogOpening = true;
    try {
      collect();
      const projectId = project.id,
        requestId = request().id,
        phase = param;
      const original =
        index >= 0 ? structuredClone(request()[phase]?.[index]) : null;
      if (index >= 0 && original?.type !== "database")
        throw Error("数据库操作已改变，请重新打开");
      const fingerprint = JSON.stringify(original),
        openingRevision = modalRevision;
      const connections = await api(
        "/projects/" + projectId + "/database-connections",
      );
      if (
        project.id !== projectId ||
        request().id !== requestId ||
        param !== phase ||
        modalRevision !== openingRevision
      )
        return;
      if (
        original &&
        JSON.stringify(request()[phase]?.[index]) !== fingerprint
      ) {
        toast("操作已改变，请重新打开编辑器", true);
        return;
      }
      if (!connections.length) {
        toast("请先到配置 → 数据库连接，授权本项目的会话连接", true);
        return;
      }
      const expired =
        original &&
        !connections.some((item) => item.id === original.connectionId);
      modal(
        (original ? "编辑" : "添加") +
          (phase === "before" ? "前置" : "后置") +
          "数据库查询",
        `<div class="form-grid"><label>会话连接</label><select id="operation-db-connection">${expired ? '<option value="" selected>原连接已失效，请重新选择</option>' : ""}${connections.map((item) => `<option value="${esc(item.id)}" ${original?.connectionId === item.id ? "selected" : ""}>${esc(item.name)} · ${esc(item.type)}</option>`).join("")}</select><label>SQL / Redis或MongoDB查询JSON</label><textarea id="operation-db-sql">${esc(original?.sql ?? "SELECT 1 AS value")}</textarea><label>绑定参数JSON数组</label><input id="operation-db-parameters" value="${esc(JSON.stringify(original?.parameters ?? []))}"><label>结果JSON路径</label><input id="operation-db-path" value="${esc(original?.path ?? "$.rows[0].value")}"><label>运行时变量名</label><input id="operation-db-name" value="${esc(original?.name ?? "dbResult")}"></div><p class="notice">只读操作先于同阶段JavaScript执行；参数支持 {{变量}}，不直接替换SQL文本。ClickHouse数组参数使用 {p0:String} 等类型化占位符。每阶段最多5项/累计10秒。结果可进入后续HTTP请求；连接不随快照导出，重启后需明确重新选择会话连接。</p>`,
        () => {
          if (
            project.id !== projectId ||
            request().id !== requestId ||
            param !== phase
          )
            throw Error("接口或阶段已切换，请重新操作");
          const operations = request()[phase] || [];
          if (original && JSON.stringify(operations[index]) !== fingerprint)
            throw Error("操作已改变，请重新打开编辑器");
          const connectionId = $("#operation-db-connection").value;
          if (!connections.some((item) => item.id === connectionId))
            throw Error("请明确选择一个已授权的会话连接");
          const parameters = parseDatabaseParameterJSON(
              $("#operation-db-parameters").value,
            ),
            name = $("#operation-db-name").value.trim();
          if (!Array.isArray(parameters) || parameters.length > 1000)
            throw Error("绑定参数须为最多1000项的数组");
          if (
            !name ||
            name.length > 100 ||
            ["__proto__", "constructor", "prototype"].includes(name)
          )
            throw Error("变量名无效");
          const enabled = original?.enabled !== false;
          if (
            enabled &&
            operations.filter(
              (item, at) =>
                at !== index &&
                item.type === "database" &&
                item.enabled !== false,
            ).length >= 5
          )
            throw Error("每阶段最多5项数据库操作");
          const operation = {
            type: "database",
            connectionId,
            sql: $("#operation-db-sql").value,
            parameters,
            name,
            path: $("#operation-db-path").value,
            enabled,
          };
          request()[phase] = original
            ? operations.map((item, at) => (at === index ? operation : item))
            : [...operations, operation];
          mark();
          render();
        },
        original ? "保存查询" : "添加查询",
      );
    } finally {
      databaseDialogOpening = false;
    }
  };
  on("#add-db-operation", "click", () => databaseOperationDialog());
  on("[data-edit-db-operation]", "click", (_, element) =>
    databaseOperationDialog(Number(element.dataset.editDbOperation)),
  );
  on("[data-remove-operation]", "click", (_, element) => {
    collect();
    const index = Number(element.dataset.removeOperation),
      operations = request()[param];
    if (
      !operations?.[index] ||
      !confirm("移除此声明式操作？不会修改数据库或已保存的计划快照。")
    )
      return;
    operations.splice(index, 1);
    mark();
    render();
  });
  on("[data-move-operation]", "click", (_, element) => {
    collect();
    const [index, delta] = element.dataset.moveOperation.split(":").map(Number),
      operations = request()[param],
      next = index + delta;
    if (
      !operations?.[index] ||
      next < 0 ||
      next >= operations.length ||
      ![-1, 1].includes(delta)
    )
      return;
    [operations[index], operations[next]] = [
      operations[next],
      operations[index],
    ];
    mark();
    render();
  });
  on("[data-toggle-db-operation]", "click", (_, element) => {
    collect();
    const operations = request()[param],
      operation = operations?.[Number(element.dataset.toggleDbOperation)];
    if (operation?.type !== "database") return;
    if (
      operation.enabled === false &&
      operations.filter(
        (item) => item.type === "database" && item.enabled !== false,
      ).length >= 5
    )
      throw Error("每阶段最多5项数据库操作");
    operation.enabled = operation.enabled === false;
    mark();
    render();
  });
  on("#db-type,#db-tls", "change", updateDatabaseFields);
  on("#db-write", "change", (_, element) => {
    $("#db-query").textContent = element.checked
      ? "确认并执行写入"
      : "执行只读查询";
  });
  updateDatabaseFields();
  void loadDatabasePreviewCapabilities($("#db-type"), api);
  on("#db-query", "click", async () => {
    const target = $("#db-result"),
      button = $("#db-query"),
      type = $("#db-type").value;
    if (button.disabled) return;
    const connectionControls = [$("#db-type"), $("#db-tls")];
    const input = isPreviewDatabase(type)
      ? {
          ...readDatabasePreviewConnection($("#db-type"), $, type),
          sql: $("#db-sql").value,
          parameters: parseDatabaseParameterJSON($("#db-params").value),
        }
      : {
          type,
          host: $("#db-host").value,
          port:
            type === "mysql"
              ? mysqlPortInput($("#db-port").value)
              : type === "mongodb"
                ? mongoPortInput($("#db-port").value)
                : Number($("#db-port").value),
          user: $("#db-user").value,
          password: $("#db-password").value,
          database: $("#db-name").value,
          ssl: $("#db-tls").checked,
          ca: $("#db-tls").checked ? $("#db-ca").value || undefined : undefined,
          authSource: $("#db-auth-source").value,
          allowWrite:
            ["sqlite", "postgres", "redis"].includes(type) &&
            $("#db-write").checked,
          filename: $("#db-path").value,
          sql: $("#db-sql").value,
          parameters: ["redis", "mongodb"].includes(type)
            ? []
            : parseDatabaseParameterJSON($("#db-params").value),
        };
    if (isPreviewDatabase(type)) {
      $("#db-password").value = "";
      $("#db-client-key").value = "";
    }
    let redisKey;
    if (input.allowWrite && type === "redis") {
      try {
        const command = JSON.parse(input.sql);
        if (
          !Array.isArray(command) ||
          typeof command[0] !== "string" ||
          command[0].toUpperCase() !== "SET" ||
          typeof command[1] !== "string" ||
          !command[1] ||
          !command[1].isWellFormed() ||
          new TextEncoder().encode(command[1]).length > 4096
        )
          throw Error(
            "Redis写入只支持明确的单键SET；键名须为1至4096字节字符串",
          );
        redisKey = JSON.stringify(command[1]);
      } catch (error) {
        $("#db-write").checked = false;
        button.textContent = "执行只读查询";
        throw error;
      }
    }
    if (
      input.allowWrite &&
      !confirm(
        (type === "postgres"
          ? "即将写入 PostgreSQL：" +
            input.host +
            ":" +
            (input.port || 5432) +
            "/" +
            input.database +
            "（用户 " +
            input.user +
            "）"
          : type === "redis"
            ? "即将写入 Redis：" +
              input.host +
              ":" +
              input.port +
              "/" +
              input.database +
              "（用户 " +
              (input.user || "default") +
              "）\n目标键：" +
              redisKey
            : "即将修改SQLite文件：" + input.filename) +
          (type === "redis" ? "\n命令预览（完整命令见编辑区）：" : "\nSQL：") +
          input.sql.slice(0, 500) +
          (type === "postgres"
            ? "\n这是数据写入，请先备份。仅支持单条 INSERT / UPDATE / DELETE，不支持 RETURNING。目标行数上限1000，不包含触发器额外变更；序列与外部副作用不能回滚。提交超时结果可能不确定，不能盲目重试。继续？"
            : type === "redis"
              ? "\nSET可能覆盖现有键及其类型；未指定EX/PX/KEEPTTL会清除原TTL。单键写入不能回滚，请先备份。确认响应不等于磁盘持久化；超时结果可能不确定，不能盲目重试。继续？"
              : "\n这是数据写入，可能更新或删除记录，请先备份。单条事务限1000条计数变更；超时结果可能不确定，不能盲目重试。继续？"),
      )
    ) {
      $("#db-write").checked = false;
      button.textContent = "执行只读查询";
      return;
    }
    const queryMarker = {};
    target.activeQuery = queryMarker;
    button.disabled = true;
    if (input.allowWrite)
      for (const control of connectionControls) control.disabled = true;
    target.textContent = input.allowWrite
      ? "正在执行写入，请勿重复提交…"
      : "正在查询…";
    try {
      const result = await api(
        "/projects/" + project.id + "/database",
        "POST",
        input,
      );
      if (target.isConnected && target.activeQuery === queryMarker) {
        target.textContent = JSON.stringify(result, null, 2);
        target.scrollIntoView({ block: "nearest" });
      }
    } catch (error) {
      if (target.isConnected && target.activeQuery === queryMarker) {
        target.textContent = error.message;
        target.scrollIntoView({ block: "nearest" });
      }
    } finally {
      if (button.isConnected && target.activeQuery === queryMarker) {
        button.disabled = false;
        for (const control of connectionControls) control.disabled = false;
        if (isPreviewDatabase($("#db-type")?.value))
          $("#db-tls").disabled = true;
        $("#db-write").checked = false;
        button.textContent = "执行只读查询";
      }
    }
  });
  on("#archive-project", "click", async () => {
    if (!confirm("归档当前项目？文件和历史会保留，可在回收站恢复。")) return;
    project.archived = true;
    mark();
    await save();
    projects = await api("/projects");
    let next = projects.find((item) => !item.archived && !item.error);
    if (!next) {
      next = await api("/projects", "POST", { name: "默认项目" });
      projects = await api("/projects");
    }
    await openProject(next.id);
  });
  on("[data-restore-project]", "click", async (_, element) => {
    const restored = await api("/projects/" + element.dataset.restoreProject);
    restored.archived = false;
    await api("/projects/" + restored.id, "PUT", restored);
    projects = await api("/projects");
    render();
    toast("项目已恢复");
  });
  on("[data-debug-env]", "click", async (_, element) => {
    const projectId = project.id;
    const context = await api(
      "/projects/" +
        projectId +
        "/debug-variables?environmentId=" +
        encodeURIComponent(element.dataset.debugEnv),
    );
    modal(
      "调试运行时变量",
      "<p>这是当前有效值，包含全局/环境基础值。修改仅影响本进程内此环境的调试；不写入项目文件。删除基础值会临时隐藏它，清空调试变量后恢复。持久化变量变化后，旧运行值也会失效。</p>" +
        jsonEditor(context.variables),
      async () => {
        await api("/projects/" + projectId + "/debug-variables", "PUT", {
          ...context,
          variables: JSON.parse($("#modal-json").value),
        });
        toast("运行时变量已更新");
      },
    );
  });
  on("#clear-session", "click", async () => {
    await api("/projects/" + project.id + "/clear-session", "POST", {});
    toast("临时变量已清空，后续调试使用已保存的环境值");
  });
  on("#project-name", "input", (_, e) => {
    project.name = e.value;
    mark();
  });
  function editVariableDefinitions(environmentId) {
    const environment = environmentId
      ? project.environments.find((item) => item.id === environmentId)
      : null;
    if (environmentId && !environment) throw Error("环境不存在");
    const values = environment
      ? environment.variables
      : project.globalVariables || {};
    const definitions = environment
      ? environment.variableDefinitions || {}
      : project.globalVariableDefinitions || {};
    const rows = variableRows(values, definitions);
    const openedProjectId = project.id,
      openedRevision = project.configRevision ?? project.revision;
    let editor;
    modal(
      environment ? "变量 · " + environment.name : "全局变量 · 初始值 / 当前值",
      '<div id="variable-editor" class="variable-editor"></div>',
      () => {
        if (
          project.id !== openedProjectId ||
          (project.configRevision ?? project.revision) !== openedRevision
        )
          throw Error("项目已更新，请重新打开变量表后编辑");
        const updated = editor.read();
        if (environment) {
          const target = project.environments.find(
            (item) => item.id === environmentId,
          );
          if (!target) throw Error("环境不存在");
          target.variables = updated.values;
          target.variableDefinitions = updated.definitions;
        } else {
          project.globalVariables = updated.values;
          project.globalVariableDefinitions = updated.definitions;
        }
        mark();
        render();
      },
    );
    editor = mountVariableEditor($("#variable-editor"), rows);
  }
  on("#edit-global-definitions", "click", () => editVariableDefinitions());
  on("[data-edit-variable-definitions]", "click", (_, element) =>
    editVariableDefinitions(element.dataset.editVariableDefinitions),
  );
  on("#edit-globals", "click", () =>
    modal(
      "编辑全局变量",
      "<p>仅编辑当前值，已有初始值和说明保持不变。删除整个变量请使用变量表。</p>" +
        jsonEditor(project.globalVariables || {}),
      () => {
        const values = JSON.parse($("#modal-json").value);
        if (!values || typeof values !== "object" || Array.isArray(values))
          throw Error("变量必须是JSON对象");
        for (const key of Object.keys(values))
          if (["__proto__", "prototype", "constructor"].includes(key))
            throw Error("变量名无效");
        project.globalVariables = values;
        mark();
        render();
      },
    ),
  );
  function editService(id) {
    const server = (project.servers || []).find((item) => item.id === id);
    modal(
      server ? "编辑共享服务" : "新建共享服务",
      `<label>服务名称</label><input id="service-name" value="${esc(server?.name || "")}">${project.environments.map((environment) => `<label>${esc(environment.name)} 地址</label><input data-service-url="${environment.id}" value="${esc(environment.serverUrls?.[id] || "")}" placeholder="https://api.example.com">`).join("")}`,
      () => {
        const name = $("#service-name").value.trim();
        if (!name) throw Error("服务名称不能为空");
        const urls = [...document.querySelectorAll("[data-service-url]")].map(
          (input) => {
            const value = input.value.trim();
            if (value) {
              let parsed;
              try {
                parsed = new URL(value);
              } catch {
                throw Error("服务地址无效");
              }
              if (
                !["http:", "https:"].includes(parsed.protocol) ||
                parsed.username ||
                parsed.password
              )
                throw Error("服务地址须为不含凭据的HTTP/HTTPS URL");
            }
            return [input.dataset.serviceUrl, value.replace(/\/$/, "")];
          },
        );
        const item = server || { id: uid(), name };
        item.name = name;
        if (!server) (project.servers ??= []).push(item);
        for (const [environmentId, url] of urls) {
          const environment = project.environments.find(
            (e) => e.id === environmentId,
          );
          (environment.serverUrls ??= {})[item.id] = url;
        }
        mark();
        render();
      },
    );
  }
  on("#add-service", "click", () => editService());
  on("[data-edit-service]", "click", (_, e) =>
    editService(e.dataset.editService),
  );
  on("[data-delete-service]", "click", (_, e) => {
    if (
      !confirm(
        "删除共享服务？绑定该服务的接口会要求重新配置；请求数据不会删除。",
      )
    )
      return;
    project.servers = (project.servers || []).filter(
      (server) => server.id !== e.dataset.deleteService,
    );
    for (const environment of project.environments)
      if (environment.serverUrls)
        delete environment.serverUrls[e.dataset.deleteService];
    mark();
    render();
  });
  function editEnvironment(id, workspace = null) {
    const owner = project;
    let item = project.environments.find((value) => value.id === id);
    let editor;
    const apply = () => {
      if (project !== owner) throw Error("项目已变化，请重新打开环境设置");
      const values = editor.read();
      const name = $("#env-name, #edit-env-name").value.trim();
      if (item) {
        item.name = name || item.name;
        item.variables = values;
      } else {
        item = { id: uid(), name: name || "新环境", variables: values };
        project.environments.push(item);
      }
      mark();
      render();
    };
    modal(
      "环境设置",
      environmentDialogHTML(project, item, { workspace: Boolean(workspace) }),
      apply,
      "保存并关闭",
    );
    editor = mountEnvironmentDialog($("#dialog-content"), item);
    $("#environment-save-stay").onclick = () => {
      try {
        apply();
        editEnvironment(item.id, workspace);
      } catch (error) {
        toast(error.message);
      }
    };
    bindEnvironmentNavigation(workspace, editor);
    $("#dialog-content [data-env-services]").onclick = () =>
      leaveEnvironmentDraft(editor, () => editService());
  }
  function editWorkspaceGlobals(workspace, query = "") {
    const owner = project;
    const epoch = editVersion;
    const draftInputs = () => [
      project.globalVariables || {},
      project.globalVariableDefinitions || {},
    ];
    const source = draftInputs();
    const original = JSON.stringify(source);
    const rows = variableRows(...source);
    let editor, revision;
    const apply = () => {
      if (
        project !== owner ||
        epoch !== editVersion ||
        revision !== modalRevision ||
        !$("#dialog").open ||
        original !== JSON.stringify(draftInputs())
      )
        throw Error("项目或变量草稿已变化，请重新打开全局变量");
      if (!editor.changed) return;
      const next = editor.read();
      if (original === JSON.stringify([next.values, next.definitions])) return;
      owner.globalVariables = next.values;
      owner.globalVariableDefinitions = next.definitions;
      mark();
      render();
    };
    modal(
      "全局变量",
      environmentDialogShell(owner, {
        workspace: true,
        section: "globals",
        content: workspaceGlobalVariablesHTML(),
        actions:
          '<button type="button" id="environment-save-stay">保存</button>',
      }),
      apply,
      "保存并关闭",
    );
    revision = modalRevision;
    editor = mountWorkspaceGlobalVariables(
      $(".environment-global-content"),
      rows,
      query,
    );
    bindEnvironmentNavigation(workspace, editor);
    $("#environment-save-stay").onclick = () => {
      try {
        apply();
        editWorkspaceGlobals(workspace, editor.query);
      } catch (error) {
        toast(error.message);
      }
    };
  }
  function editWorkspaceParameters(workspace, initialTab) {
    const owner = project;
    const epoch = editVersion;
    const source = structuredClone(owner.settings?.globalParameters);
    const original = JSON.stringify(source);
    const issue = globalParameterWorkspaceIssue(owner.settings);
    let editor, revision;
    const apply = () => {
      if (!editor) return;
      if (
        owner !== project ||
        epoch !== editVersion ||
        revision !== modalRevision ||
        !$("#dialog").open ||
        original !== JSON.stringify(project.settings?.globalParameters) ||
        globalParameterWorkspaceIssue(project.settings)
      )
        throw Error("项目或参数草稿已变化，请重新打开全局参数");
      if (!editor.changed) return;
      const next = editor.read();
      if (JSON.stringify(source ?? {}) === JSON.stringify(next)) return;
      (owner.settings ??= {}).globalParameters = next;
      mark();
      render();
    };
    modal(
      "全局参数",
      environmentDialogShell(owner, {
        workspace: true,
        section: "parameters",
        content: workspaceGlobalParametersHTML(issue),
        actions: issue
          ? ""
          : '<button type="button" id="environment-save-stay">保存</button>',
      }),
      apply,
      issue ? "完成" : "保存并关闭",
    );
    revision = modalRevision;
    if (!issue) {
      editor = mountWorkspaceGlobalParameters(
        $(".environment-parameter-content"),
        source,
        initialTab,
      );
      editor.focusTab();
      $("#environment-save-stay").onclick = () => {
        try {
          apply();
          editWorkspaceParameters(workspace, editor.kind);
        } catch (error) {
          toast(error.message);
        }
      };
      on("#environment-parameter-advanced", "click", () =>
        leaveEnvironmentDraft(editor, openGlobalParameterSettings),
      );
    } else $('[data-env-section="parameters"]')?.focus();
    bindEnvironmentNavigation(workspace, editor);
  }
  function leaveEnvironmentDraft(editor, action) {
    if (editor?.changed && !confirm("放弃尚未保存的环境修改？")) return;
    return action();
  }
  function switchEnvironmentSection(section, workspace) {
    if (section === "cookies") return openCookieManager(workspace);
    if (section === "globals")
      return workspace
        ? editWorkspaceGlobals(workspace)
        : editVariableDefinitions();
    return workspace
      ? editWorkspaceParameters(workspace)
      : openGlobalParameterSettings();
  }
  function openGlobalParameterSettings() {
    $("#dialog").close();
    page = "settings";
    settingsSection = "settings-global-parameters";
    render();
    $("#parameter-scope")?.focus();
  }
  function bindEnvironmentNavigation(workspace, editor) {
    const navigate = (action) => leaveEnvironmentDraft(editor, action);
    on("#dialog-content [data-env-open]", "click", (_, button) =>
      navigate(() => editEnvironment(button.dataset.envOpen, workspace)),
    );
    on("#dialog-content [data-env-new]", "click", () =>
      navigate(() => editEnvironment(undefined, workspace)),
    );
    on("#dialog-content [data-env-current]", "click", () =>
      $("#env-name").focus(),
    );
    on("#dialog-content [data-env-section]", "click", (_, button) => {
      if (button.getAttribute("aria-current") === "page") return;
      return navigate(() =>
        switchEnvironmentSection(button.dataset.envSection, workspace),
      );
    });
  }
  on("#open-environment-settings", "click", () => {
    const owner = project,
      requestId = current,
      dialog = $("#dialog");
    const opening = openCookieManager({
      bindNavigation: bindEnvironmentNavigation,
    });
    if (dialog.open && dialog.querySelector(".environment-dialog--workspace"))
      dialog.addEventListener(
        "close",
        () => {
          if (
            !dialog.open &&
            project === owner &&
            page === "apis" &&
            current === requestId
          )
            $("#open-environment-settings")?.focus({ preventScroll: true });
        },
        { once: true },
      );
    return opening;
  });
  on("#add-env", "click", () => editEnvironment());
  on("[data-edit-env]", "click", (_, e) => editEnvironment(e.dataset.editEnv));
  on("[data-delete-env]", "click", (_, e) => {
    if (project.environments.length === 1) throw Error("至少保留一个环境");
    project.environments = project.environments.filter(
      (v) => v.id !== e.dataset.deleteEnv,
    );
    if (project.currentEnvironmentId === e.dataset.deleteEnv)
      project.currentEnvironmentId = project.environments[0].id;
    for (const plan of project.plans)
      if (plan.environmentId === e.dataset.deleteEnv)
        plan.environmentId = project.environments[0].id;
    mark();
    render();
  });
  on("#mock-enabled", "change", (_, e) => {
    project.settings ??= {};
    project.settings.mockEnabled = e.checked;
    mark();
  });
  on("#edit-mock-rules", "click", () => {
    modal(
      "条件响应期望",
      `<p>target 支持 method、query.key、headers.name、body.path。操作 eq / neq / contains / exists；最多100条规则，延迟最多5000ms。</p>${jsonEditor(request().mockRules?.length ? request().mockRules : [{ name: "示例规则", enabled: false, conditions: [{ target: "query.role", op: "eq", value: "admin" }], response: { status: 200, headers: { "content-type": "application/json" }, body: '{"role":"admin"}', delayMs: 0 } }])}`,
      async () => {
        request().mockRules = JSON.parse($("#modal-json").value);
        mark();
        await save();
      },
    );
  });
  on("#add-example", "click", () => editExample());
  on("[data-delete-example]", "click", (_, element) => {
    const examples = request().examples,
      index = Number(element.dataset.deleteExample);
    if (!Number.isInteger(index) || index < 0 || index >= examples.length)
      throw Error("响应示例不存在");
    if (
      !confirm(
        "移除响应示例 " +
          JSON.stringify(examples[index].name || "未命名") +
          "？",
      )
    )
      return;
    examples.splice(index, 1);
    mark();
    render();
  });
  on("[data-edit-example]", "click", (_, e) =>
    editExample(Number(e.dataset.editExample)),
  );
  async function useMock(index) {
    if (saving) throw Error("正在保存，请完成后再切换Mock调试");
    collect();
    const projectId = project.id,
      requestId = current;
    const target = mockDebugTarget(
      location.origin,
      projectId,
      request(),
      index,
    );
    if (dirty) await save();
    if (project.id !== projectId || current !== requestId || dirty)
      throw Error("接口或内容已变化，未切换Mock地址，请确认后重试");
    Object.assign(request(), target);
    mode = "debug";
    mark();
    render();
  }
  on("#use-mock", "click", () => useMock());
  on("[data-use-example]", "click", (_, element) =>
    useMock(Number(element.dataset.useExample)),
  );
  async function editInterfaceCase(id) {
    collect();
    const item = (project.cases || []).find((candidate) => candidate.id === id);
    const source = item?.sourceRequestId || current;
    const ownerProjectId = project.id;
    let caseModalRevision;
    modal(
      item ? "编辑接口用例" : "新建接口用例",
      `<label>用例名称</label><input id="case-name" value="${esc(item?.name || "新用例")}"><label>分组</label><select id="case-folder"><option value="">根目录</option>${(
        project.caseFolders || []
      )
        .filter((f) => f.sourceRequestId === source)
        .map(
          (f) =>
            `<option value="${esc(f.id)}" ${item?.folderId === f.id ? "selected" : ""}>${esc(caseFolderPath(project.caseFolders, f.id))}</option>`,
        )
        .join(
          "",
        )}</select><label>独立请求快照</label>${jsonEditor(item?.request || request())}`,
      async () => {
        if (busy || saving) throw Error("请先结束当前请求或保存，再保存用例");
        nativeRequestLifecycle.assertCanSave(project.id);
        const input = {
          name: $("#case-name")?.value,
          folderId: $("#case-folder")?.value,
          requestText: $("#modal-json")?.value,
        };
        const inputChanged = () =>
          project.id !== ownerProjectId ||
          modalRevision !== caseModalRevision ||
          !$("#dialog")?.open ||
          $("#case-name")?.value !== input.name ||
          $("#case-folder")?.value !== input.folderId ||
          $("#modal-json")?.value !== input.requestText;
        if (inputChanged()) throw Error("项目或用例窗口已变化，未保存用例");
        const requestSnapshot = JSON.parse(input.requestText);
        const operation = projectImports.begin(ownerProjectId, "case");
        let posted = false;
        try {
          collect();
          if (dirty) {
            if (!confirm("当前有未保存修改，先保存再保存用例？"))
              throw Error("用例保存已取消，修改仍保留");
            await operation.saveDraft(save);
          }
          if (inputChanged() || dirty || busy || saving)
            throw Error("项目、草稿或用例内容已变化，未保存用例");
          const targetProject = project,
            version = editVersion,
            openingSequence = projectOpenSequence;
          posted = true;
          const result = await api(
            "/projects/" + ownerProjectId + "/cases",
            "POST",
            {
              id: item?.id,
              name: input.name,
              sourceRequestId: source,
              folderId: input.folderId,
              request: requestSnapshot,
              functions: item?.functions,
              createdAt: item?.createdAt,
            },
          );
          if (
            inputChanged() ||
            project !== targetProject ||
            editVersion !== version ||
            projectOpenSequence !== openingSequence ||
            dirty ||
            busy ||
            saving ||
            result?.project?.id !== ownerProjectId
          )
            throw Error("用例返回时项目或草稿已变化，未替换当前内容");
          project = result.project;
          render();
        } catch (error) {
          if (posted) {
            operation.requireReconciliation();
            throw Error(
              error.message +
                "。用例可能已写入原项目，请重新加载核对，勿直接重复提交；当前草稿仍保留。",
            );
          }
          throw error;
        } finally {
          operation.finish();
        }
      },
    );
    caseModalRevision = modalRevision;
  }
  function editCaseFolder(id) {
    const folder = (project.caseFolders || []).find((f) => f.id === id);
    const source = folder?.sourceRequestId || current;
    modal(
      folder ? "编辑用例分组" : "新建用例分组",
      `<label>名称</label><input id="case-folder-name" maxlength="200" value="${esc(folder?.name || "")}"><label>父分组</label><select id="case-folder-parent"><option value="">根目录</option>${(
        project.caseFolders || []
      )
        .filter((f) => f.sourceRequestId === source && f.id !== id)
        .map(
          (f) =>
            `<option value="${esc(f.id)}" ${folder?.parentId === f.id ? "selected" : ""}>${esc(caseFolderPath(project.caseFolders, f.id))}</option>`,
        )
        .join(
          "",
        )}</select><p class="muted">仅组织用例，不改变请求快照。只能删除空分组。</p>`,
      async () => {
        saveCaseFolder(
          project,
          id,
          {
            name: $("#case-folder-name").value,
            sourceRequestId: source,
            parentId: $("#case-folder-parent").value,
          },
          uid(),
        );
        mark();
        await save();
        render();
      },
    );
  }
  on("#new-case-folder", "click", () => editCaseFolder());
  on("[data-edit-case-folder]", "click", (event, element) => {
    event.preventDefault();
    event.stopPropagation();
    editCaseFolder(element.dataset.editCaseFolder);
  });
  on("[data-delete-case-folder]", "click", async (event, element) => {
    event.preventDefault();
    event.stopPropagation();
    if (!confirm("删除这个空用例分组？不会删除任何用例。")) return;
    removeEmptyCaseFolder(project, element.dataset.deleteCaseFolder);
    mark();
    await save();
    render();
  });
  if ($("#select-all-cases")) {
    const total = (project.cases || []).filter(
      (c) => c.sourceRequestId === current,
    ).length;
    const count = selectedInterfaceCases().size;
    $("#select-all-cases").indeterminate = count > 0 && count < total;
  }
  on("#select-all-cases", "change", (_, element) => {
    caseSelections.set(
      project.id + ":" + current,
      new Set(
        element.checked
          ? (project.cases || [])
              .filter((c) => c.sourceRequestId === current)
              .map((c) => c.id)
          : [],
      ),
    );
    render();
  });
  on("[data-select-case]", "change", (_, element) => {
    const selected = selectedInterfaceCases();
    if (element.checked) selected.add(element.dataset.selectCase);
    else selected.delete(element.dataset.selectCase);
    render();
  });
  on("#move-selected-cases", "click", () => {
    const ids = [...selectedInterfaceCases()],
      source = current;
    modal(
      "批量移动用例",
      `<p>移动 ${ids.length} 个用例，不改变请求快照。</p><label>目标分组</label><select id="case-move-target"><option value="">根目录</option>${(
        project.caseFolders || []
      )
        .filter((f) => f.sourceRequestId === source)
        .map(
          (f) =>
            `<option value="${esc(f.id)}">${esc(caseFolderPath(project.caseFolders, f.id))}</option>`,
        )
        .join("")}</select>`,
      async () => {
        moveSelectedCases(project, source, ids, $("#case-move-target").value);
        mark();
        await save();
        render();
      },
    );
  });
  on("#delete-selected-cases", "click", async () => {
    const ids = [...selectedInterfaceCases()];
    if (
      !ids.length ||
      !confirm(
        `删除选中的 ${ids.length} 个接口用例？历史执行记录及分组仍保留。`,
      )
    )
      return;
    deleteSelectedCases(project, current, ids);
    mark();
    await save();
    caseSelections.delete(project.id + ":" + current);
    render();
  });
  on("#new-interface-case", "click", () => editInterfaceCase());
  on("[data-edit-case]", "click", (_, e) =>
    editInterfaceCase(e.dataset.editCase),
  );
  on("[data-delete-case]", "click", async (_, e) => {
    if (!confirm("删除此接口用例？历史执行记录仍保留。")) return;
    project.cases = (project.cases || []).filter(
      (item) => item.id !== e.dataset.deleteCase,
    );
    mark();
    await save();
    render();
  });
  async function runInterfaceCaseBatch(ids) {
    assertExecutionReady();
    const projectId = project.id,
      source = current;
    if (dirty) await save();
    if (dirty || project.id !== projectId || current !== source)
      throw Error("当前接口已变化，请重新选择用例");
    const selected = new Set(ids),
      items = caseRunOrder(project, source).filter((item) =>
        selected.has(item.id),
      );
    if (
      selected.size !== ids.length ||
      items.length !== ids.length ||
      !items.length ||
      items.length > 100
    )
      throw Error("单次运行须选择当前接口的1至100个不同用例");
    const environmentId = env();
    caseResults.clear(projectId, ids);
    const batch = (caseBatch = {
      projectId,
      sourceRequestId: source,
      running: true,
      cancelRequested: false,
      total: items.length,
      completed: 0,
      passed: 0,
      failed: 0,
    });
    busy = true;
    runId = null;
    render();
    try {
      const summary = await runCaseBatch(
        items,
        async (item) => {
          runId = uid();
          const result = await api(
            "/projects/" + projectId + "/execute",
            "POST",
            {
              request: {
                ...item.request,
                name: item.name,
                serviceSnapshot: true,
              },
              functions: item.functions,
              environmentId,
              runId,
            },
          );
          const evidence = caseEvidence(result);
          caseResults.set(projectId, item.id, evidence, { collapsed: true });
          const latest = await api("/projects/" + projectId);
          if (project.id === projectId) {
            project.history = latest.history;
            const adoption = adoptVariableWrites(
              project,
              latest,
              result.variableWrites,
            );
            if (adoption === "none") project.revision = latest.revision;
            if (adoption === "conflict")
              toast("变量已保存，但项目还有其他变更；请重新加载并检查后再保存");
          }
          runId = null;
          return evidence;
        },
        {
          shouldStop: () => batch.cancelRequested,
          onProgress: (progress) => {
            Object.assign(batch, progress);
            render();
          },
        },
      );
      Object.assign(batch, summary);
      const completedIds = new Set(summary.results.map((entry) => entry.id));
      for (const item of items)
        if (!completedIds.has(item.id))
          caseResults.set(
            projectId,
            item.id,
            {
              outcome: "not-run",
              reason: summary.cancelled
                ? "本批次已取消，未发送此用例"
                : "本批次已停止，未发送此用例",
            },
            { collapsed: true },
          );
      for (const entry of summary.results)
        if (entry.error)
          caseResults.set(
            projectId,
            entry.id,
            { outcome: "error", error: entry.error },
            { collapsed: true },
          );
    } catch (error) {
      batch.stoppedOnError = true;
      for (const item of items)
        if (!caseResults.results(projectId).has(item.id))
          caseResults.set(
            projectId,
            item.id,
            {
              outcome: "not-run",
              reason: "批次未完成启动或已中止，未记录此用例执行",
            },
            { collapsed: true },
          );
      throw error;
    } finally {
      batch.running = false;
      batch.currentName = undefined;
      busy = false;
      runId = null;
      render();
    }
  }
  on("#run-selected-cases", "click", () =>
    runInterfaceCaseBatch([...selectedInterfaceCases()]),
  );
  on("#run-all-cases", "click", () =>
    runInterfaceCaseBatch(
      caseRunOrder(project, current).map((item) => item.id),
    ),
  );
  on("[data-run-case]", "click", async (_, e) => {
    const source = current,
      caseId = e.dataset.runCase,
      write = await prepareProjectWrite("execution");
    let posted = false,
      ownsBusy = false;
    try {
      write.assertCurrent();
      if (current !== source) throw Error("当前接口已变化，未执行用例");
      const item = project.cases.find((candidate) => candidate.id === caseId);
      if (!item) throw Error("用例已不存在");
      const environmentId = env();
      busy = true;
      ownsBusy = true;
      singleCaseRun = { projectId: write.projectId, sourceRequestId: source };
      runId = uid();
      render();
      posted = true;
      const result = await api(
        "/projects/" + write.projectId + "/execute",
        "POST",
        {
          request: { ...item.request, name: item.name, serviceSnapshot: true },
          functions: item.functions,
          environmentId,
          runId,
        },
      );
      caseResults.set(write.projectId, caseId, result);
      const latest = await api("/projects/" + write.projectId);
      write.assertCurrent(latest);
      project = latest;
    } catch (error) {
      if (posted) throw write.uncertain(error);
      throw error;
    } finally {
      if (ownsBusy) {
        busy = false;
        runId = null;
        singleCaseRun = null;
      }
      write.operation.finish();
      render();
    }
  });
  on(
    "#load-count,#load-concurrency,#load-data,#load-mode,#load-duration",
    "input",
    () => {
      loadOptions.set(project.id + ":" + current, {
        mode: $("#load-mode").value,
        durationSeconds: $("#load-duration").value,
        count: $("#load-count").value,
        concurrency: $("#load-concurrency").value,
        dataCSV: $("#load-data").value,
      });
    },
  );
  on("#load-data-file", "change", async (_, element) => {
    const file = element.files?.[0];
    if (!file) return;
    if (file.size > 65536) throw Error("压测CSV超过64 KiB");
    const key = project.id + ":" + current,
      target = $("#load-data"),
      before = target.value;
    const bytes = await file.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parseLoadCSV(text);
    if (
      !element.isConnected ||
      $("#load-data") !== target ||
      target.value !== before ||
      project.id + ":" + current !== key ||
      busy
    )
      return;
    target.value = text;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    element.value = "";
  });
  on("#load-run", "click", async () => {
    assertExecutionReady();
    collect();
    const count = Number($("#load-count").value),
      concurrency = Number($("#load-concurrency").value),
      dataCSV = $("#load-data").value;
    const timing = loadTiming({
      mode: $("#load-mode").value,
      durationSeconds: Number($("#load-duration").value),
    });
    parseLoadCSV(dataCSV);
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 100 ||
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 10
    )
      throw Error("压测次数须为1至100整数，并发须为1至10整数");
    if (
      !confirm("确认你有权执行此次压测，以及其中脚本和子请求可能产生的副作用？")
    )
      return;
    loadOptions.set(project.id + ":" + current, {
      ...timing,
      durationSeconds: $("#load-duration").value,
      count,
      concurrency,
      dataCSV,
    });
    loadResult = null;
    busy = true;
    runId = uid();
    render();
    try {
      loadResult = await api("/projects/" + project.id + "/load", "POST", {
        ...timing,
        request: request(),
        environmentId: env(),
        count,
        concurrency,
        dataCSV,
        runId,
      });
    } finally {
      busy = false;
      render();
    }
  });
  on("#new-plan,#create-case", "click", () => {
    collect();
    modal(
      "新建执行计划",
      '<label>计划名称</label><input id="plan-name" class="${plan.provenance?.fields?.name==="ai"?"ai-value":""}" value="业务流程验证"><p class="muted">保存当前接口快照，后续接口变更不会影响计划。</p>',
      async () => {
        page = "plans";
        await savePlan({
          name: $("#plan-name").value,
          environmentId: env(),
          steps: request()
            ? [{ request: snapshotInterfaceForPlan(request()) }]
            : [],
        });
      },
    );
  });
  on("[data-plan-tab]", "click", (_, element) => {
    planTab = element.dataset.planTab;
    render();
  });
  on("[data-step-drag]", "dragstart", (event, element) => {
    event.dataTransfer.setData("text/plain", element.dataset.stepDrag);
    event.dataTransfer.effectAllowed = "move";
  });
  on("[data-step-drag]", "dragover", (event) => event.preventDefault());
  on("[data-step-drag]", "drop", async (event, element) => {
    assertExecutionReady();
    event.preventDefault();
    const from = Number(event.dataTransfer.getData("text/plain")),
      to = Number(element.dataset.stepDrag);
    const plan = project.plans.find((item) => item.id === planId);
    if (
      !Number.isInteger(from) ||
      from < 0 ||
      from >= plan.steps.length ||
      from === to
    )
      return;
    const [step] = plan.steps.splice(from, 1);
    plan.steps.splice(to, 0, step);
    await savePlan(plan);
  });
  on("[data-plan]", "click", (_, e) => {
    planId = e.dataset.plan;
    planTab = "plans";
    render();
  });
  on("#plan-name,#plan-description", "input", (_, element) => {
    const plan = project.plans.find((item) => item.id === planId);
    if (plan) {
      plan[element.id === "plan-name" ? "name" : "description"] = element.value;
      mark();
    }
  });
  on("#save-plan-details", "click", async () => {
    const plan = structuredClone(project.plans.find((p) => p.id === planId));
    plan.name = $("#plan-name").value.trim();
    if (!plan.name) throw Error("计划名称不能为空");
    plan.description = $("#plan-description").value;
    plan.source = "manual";
    plan.updatedAt = new Date().toISOString();
    await savePlan(plan);
  });
  on("#delete-plan", "click", async () => {
    if (busy) throw Error("请等待执行结束");
    if (!confirm("删除这个执行计划？已有执行记录仍保留。")) return;
    project.plans = project.plans.filter((p) => p.id !== planId);
    planId = "";
    mark();
    await save();
    render();
  });
  on("#edit-plan", "click", () => {
    const p = project.plans.find((p) => p.id === planId);
    modal("编辑计划 JSON", jsonEditor(p), () =>
      savePlan(JSON.parse($("#modal-json").value)),
    );
  });
  on("#edit-plan-structure", "click", () => {
    assertExecutionReady();
    const owner = project,
      selected = planId,
      version = editVersion,
      original = project.plans.find((item) => item.id === selected);
    let collectStructure, dialogVersion;
    const assertCurrent = () => {
      if (
        project !== owner ||
        planId !== selected ||
        editVersion !== version ||
        project.plans.find((item) => item.id === selected) !== original ||
        modalRevision !== dialogVersion ||
        !$("#dialog").open
      )
        throw Error("项目、计划或草稿已变化，请重新打开结构编辑器");
      assertExecutionReady();
    };
    modal(
      "编辑步骤结构",
      planStructureEditor(),
      () => savePlan(collectStructure()),
      "保存结构",
    );
    dialogVersion = modalRevision;
    collectStructure = bindPlanStructureEditor($("#dialog-content"), original, {
      requests: structuredClone(owner.requests),
      assertCurrent,
      preview: async (candidate) => {
        assertCurrent();
        const receipt = await api(
          "/projects/" + owner.id + "/plans-validate",
          "POST",
          {
            ...candidate,
            projectConfigRevision: owner.configRevision ?? owner.revision,
          },
        );
        assertCurrent();
        if (
          receipt?.valid !== true ||
          receipt.project_id !== owner.id ||
          receipt.projectConfigRevision !==
            (owner.configRevision ?? owner.revision)
        )
          throw Error("结构预检回执不匹配，未修改草稿");
      },
    });
  });
  on("#add-step", "click", async () => {
    assertExecutionReady();
    const plan = project.plans.find((item) => item.id === planId);
    const selected = selectedPlanStepIds();
    if (!plan || !selected.length) return;
    const requests = new Map(
      project.requests
        .filter((item) => !item.deletedAt)
        .map((item) => [item.id, item]),
    );
    const steps = selected.map((id) => {
      const request = requests.get(id);
      if (!request) throw Error("所选接口已变化，请重新选择");
      return { request: snapshotInterfaceForPlan(request) };
    });
    await savePlan({ ...plan, steps: [...plan.steps, ...steps] });
  });
  const stepPicker = $("#plan-step-picker");
  const selectedPlanStepIds = stepPicker
    ? bindPlanPickerTree(stepPicker, (count) => {
        $("#add-step").disabled = !count;
        stepPicker.querySelector(":scope > summary").textContent = count
          ? "已选 " + count + " 个接口"
          : "选择要执行的接口";
      })
    : () => [];
  on("#plan-step-picker", "keydown", (event, picker) => {
    if (event.key !== "Escape" || !picker.open) return;
    event.preventDefault();
    picker.open = false;
    picker.querySelector("summary").focus();
  });
  on("#plan-step-picker", "focusout", (event, picker) => {
    if (
      picker.open &&
      event.relatedTarget &&
      !picker.contains(event.relatedTarget)
    )
      picker.open = false;
  });
  on(".plans-page", "click", (event) => {
    const picker = $("#plan-step-picker");
    if (picker?.open && !event.composedPath().includes(picker))
      picker.open = false;
  });
  on("#plan-step-picker", "toggle", (_, picker) => {
    if (picker.open) picker.querySelector("input[type=search]").focus();
  });
  on("#plan-status-policy", "change", async (_, e) => {
    assertExecutionReady();
    const plan = project.plans.find((item) => item.id === planId);
    plan.statusPolicy = e.value;
    await savePlan(plan);
  });
  on("#plan-env", "change", (_, e) => {
    assertExecutionReady();
    const p = project.plans.find((p) => p.id === planId);
    p.environmentId = e.value;
    return savePlan(p);
  });
  on("[data-step-enable]", "change", (_, e) => {
    assertExecutionReady();
    const p = project.plans.find((p) => p.id === planId);
    p.steps[e.dataset.stepEnable].enabled = e.checked;
    return savePlan(p);
  });
  on("[data-step-up]", "click", (_, e) => {
    assertExecutionReady();
    const p = project.plans.find((p) => p.id === planId),
      i = Number(e.dataset.stepUp);
    [p.steps[i - 1], p.steps[i]] = [p.steps[i], p.steps[i - 1]];
    return savePlan(p);
  });
  on("[data-step-delete]", "click", (_, e) => {
    assertExecutionReady();
    const p = project.plans.find((p) => p.id === planId);
    p.steps.splice(Number(e.dataset.stepDelete), 1);
    return savePlan(p);
  });
  on("[data-step-edit]", "click", (_, e) => {
    const p = project.plans.find((p) => p.id === planId),
      i = Number(e.dataset.stepEdit);
    let collectEdits;
    modal("编辑步骤快照", stepEditor(p.steps[i]), () => {
      const candidate = structuredClone(p);
      candidate.steps[i] = collectEdits();
      return savePlan(candidate);
    });
    collectEdits = bindStepEditor($("#dialog-content"), p.steps[i]);
  });
  on("#run-plan", "click", async () => {
    const selectedPlan = planId,
      write = await prepareProjectWrite("execution");
    let posted = false,
      ownsBusy = false;
    try {
      write.assertCurrent();
      if (planId !== selectedPlan) throw Error("计划选择已变化，未执行");
      busy = true;
      ownsBusy = true;
      runId = uid();
      render();
      posted = true;
      const result = await api(
        "/projects/" + write.projectId + "/run",
        "POST",
        {
          planId: selectedPlan,
          runId,
        },
      );
      if (project.id === write.projectId) lastRun = result;
      const updated = await api("/projects/" + write.projectId);
      write.assertCurrent(updated);
      project = updated;
      if (planId === selectedPlan) planTab = "runs";
    } catch (error) {
      if (posted) throw write.uncertain(error);
      throw error;
    } finally {
      if (ownsBusy) busy = false;
      write.operation.finish();
      render();
    }
  });
  const bindRunExports = () =>
    on("[data-export-run]", "click", (_, e) =>
      download(
        "run-" + e.dataset.exportRun + ".json",
        lastRun?.id === e.dataset.exportRun
          ? lastRun
          : project.runs.find((r) => r.id === e.dataset.exportRun),
      ),
    );
  bindRunExports();
  on("#refresh-plan-history", "click", async (_, button) => {
    if (busy || saving) throw Error("请先结束当前执行或保存，再刷新记录");
    const owner = project,
      opening = projectOpenSequence,
      version = editVersion,
      previousRun = lastRun,
      previousRuns = project.runs,
      target = $("#plan-run-records"),
      status = $("#plan-history-refresh-status");
    const isCurrent = () =>
      project === owner &&
      projectOpenSequence === opening &&
      editVersion === version &&
      lastRun === previousRun &&
      !busy &&
      !saving &&
      page === "plans" &&
      planTab === "runs" &&
      target.isConnected;
    let replacedFocus = null;
    button.disabled = true;
    status.textContent = "正在只读刷新已保存记录…";
    try {
      const runs = await refreshPlanHistory({
        owner,
        read: (id) => api("/projects/" + id),
        isCurrent,
      });
      if (!isCurrent() || owner.runs !== previousRuns)
        throw Error("页面或执行记录已变化，未替换记录；请重新刷新");
      // Do not call render/openProject: they may replace editors. In particular,
      // this GET cannot acknowledge an uncertain write or advance CAS revisions.
      const html = renderRuns(
        previousRun
          ? [previousRun, ...runs.filter((run) => run.id !== previousRun.id)]
          : runs,
        previousRun,
      );
      replacedFocus = capturePlanHistoryFocus(target, document.activeElement);
      owner.runs = runs;
      target.innerHTML = html;
      bindRunExports();
      status.textContent = "已刷新已保存记录；草稿和项目版本未变。";
    } catch (error) {
      if (status.isConnected) status.textContent = error.message;
    } finally {
      if (button.isConnected) button.disabled = false;
      restorePlanHistoryFocus(target, button, replacedFocus);
    }
  });
  on("#history-project-reload", "click", () => openProject(project.id));
  on("#protocol-history-filter", "submit", (event) => {
    event.preventDefault();
    applyProtocolHistoryFilters($("#protocol-history"), project);
  });
  on("#protocol-history-filter-clear", "click", () => {
    $("#protocol-history-filter").reset();
    applyProtocolHistoryFilters($("#protocol-history"), project);
  });
  on("[data-protocol-history]", "click", (_, e) => {
    const detail = protocolHistoryDetail(
      project,
      e.dataset.protocolProject,
      e.dataset.protocolHistory,
    );
    if (detail !== null) modal("已保存协议记录", detail, () => {}, "关闭");
  });
  on("[data-protocol-history-export]", "click", (_, e) => {
    const prepared = prepareProtocolHistoryExport(
      project,
      e.dataset.protocolProject,
      e.dataset.protocolHistoryExport,
    );
    if (!prepared) return;
    modal(
      "导出已保存协议记录",
      prepared.preview +
        '<p class="notice">下载文件包含上方完整原始记录，可能包含消息正文和敏感信息，未脱敏。仅导出这条已保存记录，不包含活动会话，不是项目备份，不执行或重发请求。请确认后下载，分享前检查。</p>',
      () => download("protocol-record.json", prepared.confirm(project)),
      "确认下载未脱敏记录",
    );
  });
  on("[data-history]", "click", (_, e) => {
    const h = project.history.find((h) => h.id === e.dataset.history);
    modal(
      h.name,
      `<pre>${esc(JSON.stringify(h, null, 2))}</pre>`,
      () => download("request-history.json", h),
      "导出",
    );
  });
  on("#add-model-folder", "click", () => editModelFolder());
  on("[data-edit-model-folder]", "click", (event, element) => {
    event.preventDefault();
    event.stopPropagation();
    editModelFolder(element.dataset.editModelFolder);
  });
  on("[data-delete-model-folder]", "click", (event, element) => {
    event.preventDefault();
    event.stopPropagation();
    if (!confirm("删除这个空模型目录？不会删除任何数据模型。")) return;
    removeEmptyModelFolder(project, element.dataset.deleteModelFolder);
    mark();
    render();
  });
  on("#add-dictionary", "click", () => editDictionary());
  on("[data-edit-dictionary]", "click", (_, e) =>
    editDictionary(Number(e.dataset.editDictionary)),
  );
  on("[data-use-dictionary]", "click", (_, e) => {
    if (!request()) throw Error("请先选择接口");
    request().schema = structuredClone(
      project.dictionary[e.dataset.useDictionary].schema,
    );
    mark();
    page = "apis";
    activeDocumentId = null;
    mode = "design";
    render();
  });
  on("#export-docs", "click", () =>
    modal(
      "导出离线文档",
      '<label>格式</label><select id="document-format"><option value="html">独立 HTML（浏览器直接打开）</option><option value="markdown">Markdown</option></select><div class="notice">文档包含请求和响应示例，可能含敏感字段。请检查后再分享。</div>' +
        attributeChooser(project),
      () => {
        const format = $("#document-format").value;
        download(
          project.name + (format === "html" ? ".html" : ".md"),
          exportDocumentation(project, format, {
            attributeKeys: selectedSharedAttributes(),
          }),
          format === "html" ? "text/html" : "text/markdown",
        );
      },
      "导出",
    ),
  );
}
function bindTree() {
  for (const folder of document.querySelectorAll("[data-tree-folder]")) {
    const key = project.id + ":" + folder.dataset.treeFolder;
    folder.ontoggle = () => {
      if (!folder.isConnected || search) return;
      if (folder.open) collapsedFolders.delete(key);
      else collapsedFolders.add(key);
    };
  }

  on("[data-socketio-definition]", "click", (_, element) => {
    collect();
    if (busy || saving) throw Error("请等待当前请求或保存结束");
    syncSocketIOWorkbench();
    if (
      socketioWorkbenchState.draftDirty &&
      !confirm("当前Socket.IO定义草稿未保存，确定切换定义？")
    )
      return;
    const definition = project.settings?.socketioDefinitions?.find(
      (item) => item.id === element.dataset.socketioDefinition,
    );
    if (!definition) throw Error("Socket.IO定义不存在");
    selectSocketIO(socketioWorkbenchState, definition);
    page = "socketio";
    render();
  });
  on("[data-grpc-definition]", "click", (_, element) => {
    collect();
    if (busy || saving) throw Error("请等待当前请求或保存结束");
    syncGrpcWorkbench();
    if (
      grpcWorkbenchState.draftDirty &&
      !confirm("当前gRPC定义草稿未保存，确定切换定义？")
    )
      return;
    const definition = project.settings?.grpcDefinitions?.find(
      (item) => item.id === element.dataset.grpcDefinition,
    );
    if (!definition) throw Error("gRPC定义不存在");
    selectGrpcUnary(grpcWorkbenchState, definition);
    page = "grpc";
    render();
  });
  on("[data-document-index]", "click", (event, element) => {
    const item = project.documents[Number(element.dataset.documentIndex)];
    const keyboard = event.detail === 0 && element === document.activeElement;
    openWorkspaceDocument(item?.id);
    if (keyboard) $(".tab.selected .tab-switch")?.focus();
  });
  on("[data-protocol-id]", "click", (_, element) => {
    collect();
    const item = project.protocols.find(
      (item) => item.id === element.dataset.protocolId,
    );
    if (!item) return;
    selectedProtocolId = item.id;
    page = "protocols";
    render();
    $("#protocol-type").value = item.type;
    $("#protocol-url").value = item.url;
    $("#protocol-port").value = item.port || "";
    $("#protocol-name").value = item.name;
  });
  on("[data-edit-folder]", "click", (_, element) => {
    collect();
    const old = element.dataset.editFolder;
    modal(
      "编辑目录",
      `<label>目录名称</label><input id="folder-name" value="${esc(old)}"><label>目录默认服务</label><select id="folder-service"><option value="">不绑定服务</option>${project.settings?.folderServices?.[old] && !(project.servers || []).some((service) => service.id === project.settings.folderServices[old]) ? `<option selected value="${esc(project.settings.folderServices[old])}">已删除服务（保留引用）</option>` : ""}${(project.servers || []).map((service) => `<option value="${esc(service.id)}" ${project.settings?.folderServices?.[old] === service.id ? "selected" : ""}>${esc(service.name)}</option>`).join("")}</select><p class="muted">只影响本目录未显式绑定服务的相对路径接口；完整 URL 保持直连。已有计划和用例快照不变。</p><label><input id="folder-remove" type="checkbox">删除此目录及所有子目录，将其中内容移至未分组（共享配置将移除）</label>`,
      () => {
        const remove = $("#folder-remove").checked,
          name = $("#folder-name").value.trim();
        if (!remove && !name) throw Error("名称不能为空");
        const changed = moveFolderTree(project, old, remove ? null : name);
        const serviceId = $("#folder-service").value;
        if (!remove) {
          changed.settings.folderServices ??= {};
          delete changed.settings.folderServices[name];
          if (serviceId)
            Object.defineProperty(changed.settings.folderServices, name, {
              value: serviceId,
              enumerable: true,
              writable: true,
              configurable: true,
            });
        }
        const selectedScope = parameterScopes.get(project.id) || "";
        if (selectedScope === old || selectedScope.startsWith(old + "/"))
          parameterScopes.set(
            project.id,
            remove ? "" : name + selectedScope.slice(old.length),
          );
        for (const key of [...collapsedFolders])
          if (
            key === project.id + ":" + old ||
            key.startsWith(project.id + ":" + old + "/")
          )
            collapsedFolders.delete(key);
        project = changed;
        mark();
        render();
      },
    );
  });

  on("[data-request]", "click", (_, e) => {
    collect();
    current = e.dataset.request;
    activeDocumentId = null;
    if (!opened.includes(current)) opened.push(current);
    page = "apis";
    response = responses.get(project.id + ":" + current) || null;
    render();
  });
}
function editExample(index, designScope) {
  const r = request(),
    ex = r.examples[index] || {
      name: designScope ? "响应示例" : "成功响应",
      status: designScope ? Number(designScope.definition.status) : 200,
      body: designScope ? "{}" : '{\n  "success": true\n}',
      ...(designScope
        ? { headers: { "content-type": designScope.media } }
        : {}),
    };
  modal(
    "响应示例",
    `<div class="example-settings"><label>名称<input id="ex-name" value="${esc(ex.name)}"></label><label>状态码<input id="ex-status" type="number" value="${esc(ex.status)}" ${designScope ? "readonly" : ""}></label><label>延迟（ms）<input id="ex-delay" type="number" min="0" max="5000" value="${esc(ex.delayMs ?? 0)}"></label></div><p class="muted">100–199 仅作为文档示例；204/205/304 不发送正文。延迟范围 0–5000ms。</p><label>响应内容（允许为空）</label><textarea id="ex-body">${esc(ex.body)}</textarea><label>响应头（JSON对象，禁止传输/隔离控制头）</label><textarea id="ex-headers">${esc(JSON.stringify(ex.headers ?? {}, null, 2))}</textarea>`,
    () => {
      const val = editResponseExample(ex, {
        name: $("#ex-name").value,
        status: Number($("#ex-status").value),
        body: $("#ex-body").value,
        headers: JSON.parse($("#ex-headers").value.trim() || "{}"),
        delayMs: Number($("#ex-delay").value),
      });
      if (designScope) {
        if (
          request() !== r ||
          !r.responses.includes(designScope.definition) ||
          (index !== undefined && r.examples[index] !== ex)
        )
          throw Error("响应示例草稿已变化，请重新打开");
        if (
          String(val.status) !== String(designScope.definition.status) ||
          exampleMedia(val.headers) !== designScope.media
        )
          throw Error("请在所属响应状态和 Content-Type 下编辑示例");
        try {
          JSON.parse(val.body);
        } catch {
          throw Error("JSON 响应示例正文无效");
        }
      }
      if (index === undefined) r.examples.push(val);
      else r.examples[index] = val;
      mark();
      render();
    },
  );
}

function editModelFolder(id) {
  const folder =
    id === undefined
      ? { name: "新目录", parentId: "", description: "" }
      : project.modelFolders.find((item) => item.id === id);
  if (!folder) throw Error("模型目录不存在");
  modal(
    "模型目录",
    `<label>名称</label><input id="model-folder-name" maxlength="200" value="${esc(folder.name)}"><label>父目录</label><select id="model-folder-parent"><option value="">根目录</option>${(
      project.modelFolders || []
    )
      .filter((item) => item.id !== id)
      .map(
        (item) =>
          `<option value="${esc(item.id)}" ${folder.parentId === item.id ? "selected" : ""}>${esc(modelFolderPath(project.modelFolders, item.id))}</option>`,
      )
      .join(
        "",
      )}</select><label>说明</label><textarea id="model-folder-description" maxlength="5000">${esc(folder.description || "")}</textarea><p class="muted">移动目录会保留模型和子目录的ID；不能移动到自身子目录。仅空目录可以删除。</p>`,
    () => {
      saveModelFolder(
        project,
        id,
        {
          name: $("#model-folder-name").value,
          parentId: $("#model-folder-parent").value,
          description: $("#model-folder-description").value,
        },
        uid(),
      );
      mark();
      render();
    },
  );
}
function editDictionary(index) {
  const d = project.dictionary[index] || {
    name: "新模型",
    schema: { type: "object", properties: { id: { type: "integer" } } },
  };
  modal(
    "数据模型",
    `<label>名称</label><input id="dict-name" maxlength="500" value="${esc(d.name)}"><label>模型目录</label><select id="dict-folder"><option value="">根目录</option>${(project.modelFolders || []).map((folder) => `<option value="${esc(folder.id)}" ${d.folderId === folder.id ? "selected" : ""}>${esc(modelFolderPath(project.modelFolders, folder.id))}</option>`).join("")}</select><p class="muted">模型ID保持不变。修改关联组件后，引用该模型的后续数据生成将使用新Schema。</p><details><summary>从 JSON / XML / MySQL DDL 生成 Schema</summary><label>输入格式<select id="model-source-format"><option value="json">JSON 样例</option><option value="mysql">MySQL CREATE TABLE</option><option value="xml">XML → JSON结构</option></select></label><p class="muted">仅静态生成草稿，不执行SQL。输入最多64KiB；JSON最多2000节点、20层、16种数组结构，保留example，后续改结构须同步更新或删除example。DDL沿用字典的有限类型映射，保留注释/字面默认值/枚举；表达式只作说明，不猜测API必填、可空、长度范围或键约束。XML映射为JSON结构：属性放$、叶子文本保持字符串、重复节点为数组；禁止DTD/实体和混合内容，不生成XML正文。确认后才修改模型。</p><textarea id="model-json-sample" placeholder="粘贴JSON、XML样例或单条MySQL CREATE TABLE"></textarea><button type="button" id="infer-model-schema">生成预览</button><p id="model-infer-error" role="alert"></p></details>${jsonEditor(d.schema)}`,
    () => {
      saveModel(
        project,
        index,
        {
          name: $("#dict-name").value,
          schema: JSON.parse($("#modal-json").value),
          folderId: $("#dict-folder").value,
        },
        uid(),
      );
      mark();
      render();
    },
  );
  $("#infer-model-schema").onclick = () => {
    try {
      const source = $("#model-json-sample").value;
      const schema =
        $("#model-source-format").value === "mysql"
          ? inferSchemaFromMySQL(source)
          : $("#model-source-format").value === "xml"
            ? inferSchemaFromXML(source)
            : inferSchemaFromJSON(source);
      $("#modal-json").value = JSON.stringify(schema, null, 2);
      $("#model-infer-error").textContent = "已生成草稿；请核对后确认保存。";
    } catch (error) {
      $("#model-infer-error").textContent = error.message;
    }
  };
}
async function send() {
  assertExecutionReady();
  collect();
  const targetId = current,
    projectId = project.id,
    revision = project.revision;
  const snapshot = structuredClone(request());
  const environmentId = env();
  busy = true;
  runId = uid();
  render();
  let result;
  try {
    result = await api("/projects/" + projectId + "/execute", "POST", {
      request: snapshot,
      environmentId,
      runId,
    });
    const updated = await api("/projects/" + projectId);
    if (project.id === projectId) {
      const adoption = adoptVariableWrites(
        project,
        updated,
        result.variableWrites,
      );
      if (adoption === "none" && updated.revision === revision + 1)
        project.revision = updated.revision;
      if (adoption === "conflict")
        toast("变量已保存，但项目还有其他变更；请重新加载并检查后再保存");
      project.history = updated.history;
    }
  } catch (error) {
    result = { error: error.message };
  } finally {
    responses.set(projectId + ":" + targetId, result);
    if (project.id === projectId && current === targetId) response = result;
    busy = false;
    render(true);
  }
}
document.addEventListener("keydown", (e) => {
  if ($("#dialog").open) {
    if ((e.ctrlKey || e.metaKey) && ["s", "Enter"].includes(e.key))
      e.preventDefault();
    return;
  }
  if (e.key === "Escape" && bodyExpanded && !$("#dialog").open) {
    collect();
    bodyExpanded = false;
    render();
    $("#expand-body")?.focus();
  }

  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    save().catch((e) => toast(e.message));
  }
  if (
    (e.ctrlKey || e.metaKey) &&
    e.key === "Enter" &&
    page === "apis" &&
    !busy
  ) {
    e.preventDefault();
    send().catch((error) => toast(error.message));
  }
});
window.addEventListener("beforeunload", (e) => {
  if (
    dirty ||
    (grpcWorkbenchProject === project?.id && grpcWorkbenchState?.draftDirty) ||
    (socketioWorkbenchProject === project?.id &&
      socketioWorkbenchState?.draftDirty)
  ) {
    e.preventDefault();
    e.returnValue = "";
  }
});
async function init() {
  compactUI = localStorage.getItem("compact-ui") === "true";
  responseLayout =
    localStorage.getItem("response-layout") === "split" ? "split" : "stacked";
  if (localStorage.getItem("theme") === "dark")
    document.body.classList.add("dark");
  token =
    new URLSearchParams(location.hash.slice(1)).get("token") ||
    sessionStorage.getItem("local-api-token") ||
    "";
  if (location.hash)
    history.replaceState(null, "", location.pathname + location.search);
  const localSession = await api("/session");
  token = localSession.token;
  sessionController = createProtocolSessionController({
    api,
    storage: sessionStorage,
    instanceId: localSession.instanceId,
    onChange: (state) => {
      sessionState = state;
      activeSession = state.snapshot;
      showSession();
    },
  });
  await sessionController.restore();
  sessionStorage.setItem("local-api-token", token);
  projects = await api("/projects");
  if (!projects.some((item) => !item.archived && !item.error)) {
    const p = await api("/projects", "POST", { name: "默认项目" });
    p.environments[0].variables.baseUrl = location.origin;
    const r = defaultRequest("示例 · 创建用户");
    r.method = "POST";
    r.bodyType = "json";
    r.body = JSON.stringify(
      {
        id: 0,
        username: "username",
        firstName: "",
        lastName: "",
        email: "",
        password: "",
        phone: "",
        userStatus: 0,
      },
      null,
      2,
    );
    r.description = "本地 Mock 响应示例，不是真实用户账户服务。";
    r.folder = "示例接口";
    r.url = location.origin + "/mock/" + p.id + "/" + r.id;
    r.examples = [
      {
        name: "成功响应",
        status: 200,
        body: '{\n  "message": "欢迎使用 Local API",\n  "local": true\n}',
      },
    ];
    r.assertions = [{ target: "status", op: "eq", value: 200 }];
    p.requests.push(r);
    await api("/projects/" + p.id, "PUT", p);
    projects = await api("/projects");
  }
  await openProject(
    projects.find(
      (p) =>
        !p.archived && !p.error && p.id === sessionStorage.getItem("project"),
    )?.id || projects.find((p) => !p.archived && !p.error).id,
  );
}
init().catch((e) => {
  $("#app").innerHTML =
    '<div class="page"><h1>无法启动工作台</h1><pre>' +
    esc(e.message) +
    "</pre><p>请确认本地服务正在运行，然后刷新页面。</p></div>";
});

function selectedSharedAttributes() {
  return [
    ...$("#dialog-content").querySelectorAll("[data-share-attribute]:checked"),
  ].map((element) => element.value);
}
function editAttributeDefinition(index) {
  const existing = project.settings?.attributes?.[index];
  const labels = {
    string: "文本",
    number: "数字",
    select: "单选",
    multiselect: "多选",
    date: "日期",
    url: "链接",
    email: "邮箱",
    boolean: "布尔（兼容）",
  };
  modal(
    existing ? "编辑接口属性" : "新增接口属性",
    `<label>稳定标识</label><input id="attribute-key" value="${esc(existing?.key || "")}" ${existing ? "disabled" : ""}><label>显示名称</label><input id="attribute-label" value="${esc(existing?.label || "")}"><label>类型</label><select id="attribute-type">${attributeTypes.map((type) => `<option value="${type}" ${(existing?.type || "string") === type ? "selected" : ""}>${labels[type]}</option>`).join("")}</select><label><input id="attribute-enabled" type="checkbox" ${existing?.enabled !== false ? "checked" : ""}>在接口与文档中启用（停用保留已有值）</label><label>填写提示</label><textarea id="attribute-description" rows="2" maxlength="2000">${esc(existing?.description || "")}</textarea><label>单选/多选选项（每行一个值，或 JSON 数组；其他类型忽略）</label><textarea id="attribute-options">${esc(JSON.stringify(existing?.options || [], null, 2))}</textarea><p class="muted">更改类型或删除选项时，会检查现有值，避免静默丢失数据。</p>`,
    async () => {
      const type = $("#attribute-type").value;
      const field = {
        ...existing,
        key: $("#attribute-key").value.trim(),
        label: $("#attribute-label").value.trim(),
        enabled: $("#attribute-enabled").checked,
        description: $("#attribute-description").value,
        type,
      };
      if (["select", "multiselect"].includes(type)) {
        const source = $("#attribute-options").value.trim();
        field.options = source.startsWith("[")
          ? JSON.parse(source)
          : source
              .split(/\r?\n/)
              .map((value) => value.trim())
              .filter(Boolean);
      }
      const fields = [...(project.settings?.attributes || [])];
      if (index === undefined) fields.push(field);
      else fields[index] = field;
      validateAttributeDefinitions(fields);
      for (const record of [...project.requests, ...project.documents])
        validateAttributeValues(record.attributes, fields);
      project.settings ??= {};
      const previous = project.settings.attributes;
      project.settings.attributes = fields;
      mark();
      try {
        await save();
      } catch (error) {
        rollbackProjectSave(error, () => {
          project.settings.attributes = previous;
        });
        throw error;
      }
      if (index === undefined) index = fields.length - 1;
    },
  );
}

function editErrorCode(index) {
  const existing = project.settings?.statusCodes?.[index];
  modal(
    existing ? "编辑错误码" : "新增错误码",
    `<label>错误码</label><input id="error-code-value" value="${esc(existing?.code ?? "")}" placeholder="0、10001、AUTH_EXPIRED"><label>说明</label><textarea id="error-code-label">${esc(existing?.label || "")}</textarea><label><input id="error-code-http" type="checkbox" ${existing?.httpHint ? "checked" : ""}>同时用于 HTTP 状态提示（仅100至599）</label>`,
    async () => {
      const raw = $("#error-code-value").value.trim();
      const number = Number(raw);
      const item = {
        code:
          Number.isSafeInteger(number) && String(number) === raw ? number : raw,
        label: $("#error-code-label").value,
        httpHint: $("#error-code-http").checked,
      };
      project.settings ??= {};
      project.settings.statusCodes ??= [];
      const previous = [...project.settings.statusCodes];
      if (index === undefined) project.settings.statusCodes.push(item);
      else project.settings.statusCodes[index] = item;
      mark();
      try {
        await save();
      } catch (error) {
        rollbackProjectSave(error, () => {
          project.settings.statusCodes = previous;
        });
        throw error;
      }
      if (index === undefined) index = project.settings.statusCodes.length - 1;
    },
  );
}

function editMockField(id) {
  const existing = project.settings?.mockFieldRules?.find(
    (rule) => rule.id === id,
  );
  const ruleId = id || uid();
  modal(
    existing ? "编辑字段 Mock 规则" : "新建字段 Mock 规则",
    `${existing?.apipostSource ? "<p>原版导入规则：仅精确或星号/问号/ASCII集合/候选项匹配字段名及相同字段类型；数值字段带 minimum/maximum 时不采用此规则。支持 integer/natural、timestamp/randomInt、受限 float 、显式ASCII字符池 string 、字符池 character/char 、字符串列表 pick 、word/title/sentence/paragraph 、guid/uuid、isoTimestamp（UTC）或 date/time/datetime/now（本机时区），保留原版来源。其他规则请另行新建。</p>" : ""}<label>规则名称</label><input id="mock-field-name" value="${esc(existing?.name || "")}"><label>${existing?.apipostSource ? (existing.apipostSource.matchType === "wildcard" ? "字段名（星号/问号/ASCII集合/候选项）" : "字段名（精确匹配）") : "字段通配符"}</label><input id="mock-field-pattern" value="${esc(existing?.pattern || "{name,*_name}")}"><label>字段类型</label><select id="mock-field-type">${(existing?.apipostSource ? ["integer", "number", "string"] : ["any", "string", "integer", "number", "boolean", "object", "array"]).map((type) => `<option ${(existing?.type || "string") === type ? "selected" : ""}>${type}</option>`).join("")}</select><label>${existing?.apipostSource ? "原版 Mock 表达式" : "Mock 表达式 / JSON 常量"}</label><input id="mock-field-value" value="${esc(existing?.mock ?? "@cname()")}"><label><input id="mock-field-ignore-case" type="checkbox" ${existing?.ignoreCase ? "checked" : ""}>忽略字段名大小写</label>`,
    async () => {
      project.settings ??= {};
      project.settings.mockFieldRules ??= [];
      const rule = {
        id: ruleId,
        ...(existing?.apipostSource
          ? { apipostSource: { ...existing.apipostSource } }
          : {}),
        name: $("#mock-field-name").value,
        pattern: $("#mock-field-pattern").value,
        type: $("#mock-field-type").value,
        mock: $("#mock-field-value").value,
        ignoreCase: $("#mock-field-ignore-case").checked,
        enabled: existing?.enabled !== false,
      };
      const index = project.settings.mockFieldRules.findIndex(
        (item) => item.id === ruleId,
      );
      const previous = [...project.settings.mockFieldRules];
      if (index < 0) project.settings.mockFieldRules.push(rule);
      else project.settings.mockFieldRules[index] = rule;
      mark();
      try {
        await save();
      } catch (error) {
        rollbackProjectSave(error, () => {
          project.settings.mockFieldRules = previous;
        });
        throw error;
      }
    },
  );
}

function bindWorkspaceDocument() {
  const doc = workspaceDocument();
  if (!doc) return;
  const owner = project;
  const active = () => owner === project && workspaceDocument() === doc;
  const preview = $("#workspace-document-preview");
  prepareWorkspaceDocumentLinks(preview);
  on("#workspace-document-toggle", "click", () => {
    if (!active()) return;
    const prefs = documentModes.get(doc.id);
    const editing = prefs?.view !== "edit";
    documentModes.set(doc.id, { ...prefs, view: editing ? "edit" : "preview" });
    render();
    $(
      editing ? "#workspace-document-text" : "#workspace-document-toggle",
    )?.focus();
  });
  on("#workspace-document-settings", "click", () => {
    if (active()) editDocument(owner.documents.indexOf(doc), doc);
  });
  on("#workspace-document-title", "input", (_, input) => {
    if (!active() || !input.isConnected || doc.title === input.value) return;
    doc.title = input.value;
    mark();
    const title = doc.title || "未命名文档";
    $(".tab.selected [data-workspace-document-tab-name]").textContent = title;
    $(".tab.selected [data-close-document-tab]").setAttribute(
      "aria-label",
      "关闭 " + title,
    );
    $("#tree").innerHTML = tree();
    bindTree();
  });
  const input = $("#workspace-document-text");
  if (input)
    bindLocalDocumentImage({
      picker: $("#workspace-document-image-file"),
      input,
      trigger: $("#workspace-document-image"),
      active: () => active() && !$("#dialog").open,
      notify: toast,
    });
  const linked = $("#workspace-document-sync");
  const scroll =
    input &&
    bindWorkspaceDocumentScroll(input, preview, {
      active: () => active() && input.isConnected,
      enabled: () => linked.checked,
    });
  on("#workspace-document-sync", "change", (_, checkbox) => {
    if (!active() || !checkbox.isConnected) return;
    documentModes.set(doc.id, {
      ...documentModes.get(doc.id),
      synchronized: checkbox.checked,
    });
  });
  on("#workspace-document-top", "click", () => scroll?.top());
  let previewTimer;
  on("#workspace-document-text", "input", () => {
    if (!active() || !input.isConnected || doc.content === input.value) return;
    doc.content = input.value;
    mark();
    $("#workspace-document-count").textContent = documentCounts(doc.content);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (active() && input.isConnected) {
        preview.innerHTML = renderMarkdown(doc.content);
        prepareWorkspaceDocumentLinks(preview);
        scroll.refreshPreview();
      }
    }, 120);
  });
  on("[data-workspace-markdown]", "click", (_, control) => {
    if (!active() || !input?.isConnected) return;
    const patch = markdownEdit(
      control.dataset.workspaceMarkdown,
      input.value,
      input.selectionStart,
      input.selectionEnd,
    );
    if (!patch || !insertTextareaText(input, patch)) return;
    input.setSelectionRange(patch.anchor, patch.anchor + patch.length);
  });
}

function editDocument(index, workspaceOwner) {
  const owner = project,
    openedVersion = editVersion;
  let initialInput;
  const existing = project.documents[index] || {
    title: "新文档",
    content: "# 使用说明\n\n",
  };
  const statuses = project.settings?.statuses || [];
  modal(
    "项目文档",
    `<label>标题</label><input id="document-title" value="${esc(existing.title)}"><label>目录</label><input id="document-folder" value="${esc(existing.folder || "")}"><label>状态</label><select id="document-status"><option value="">未设置状态</option>${existing.statusId && !statuses.some((status) => status.id === existing.statusId) ? `<option selected value="${esc(existing.statusId)}">已删除状态（保留标记）</option>` : ""}${statuses.map((status) => `<option value="${esc(status.id)}" ${status.id === existing.statusId ? "selected" : ""}>${esc(status.name)}</option>`).join("")}</select><div class="form-grid">${attributeFields(project.settings?.attributes || [], existing.attributes, "doc-attribute")}</div><label>Markdown 正文</label><textarea id="document-content">${esc(existing.content)}</textarea><label>插入本地图片（PNG/JPEG，最多128KiB，随文档离线保存）</label><input id="document-image" type="file" accept="image/png,image/jpeg"><label>实时预览</label><div id="document-preview" class="markdown-content"></div>`,
    () => {
      if (
        workspaceOwner &&
        (owner !== project ||
          openedVersion !== editVersion ||
          workspaceDocument() !== workspaceOwner ||
          project.documents[index] !== workspaceOwner)
      )
        throw Error("项目或文档草稿已变化，请重新打开文档设置");
      const fields = project.settings?.attributes || [];
      validateAttributeDefinitions(fields);
      const attributes = { ...(existing.attributes || {}) };
      for (const element of $("#dialog-content").querySelectorAll(
        "[data-doc-attribute]",
      )) {
        const field = fields.find(
          (item) => item.key === element.dataset.docAttribute,
        );
        const value = attributeInputValue(element, field);
        if (value === undefined) delete attributes[field.key];
        else attributes[field.key] = value;
      }
      validateAttributeValues(attributes, fields);
      const record = {
        ...existing,
        id: existing.id || uid(),
        title: $("#document-title").value,
        folder: $("#document-folder").value,
        statusId: $("#document-status").value,
        attributes,
        content:
          workspaceOwner && $("#document-content").value === initialInput
            ? existing.content
            : $("#document-content").value,
      };
      if (index === undefined) project.documents.push(record);
      else project.documents[index] = record;
      mark();
      render();
    },
    workspaceOwner ? "应用到项目草稿" : undefined,
    workspaceOwner
      ? () => {
          if (
            owner === project &&
            workspaceDocument()?.id === workspaceOwner.id
          )
            $("#workspace-document-settings")?.focus();
        }
      : undefined,
  );
  const input = $("#document-content"),
    preview = $("#document-preview");
  initialInput = input.value;
  let timer;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      preview.innerHTML = renderMarkdown(input.value);
    }, 120);
  };
  const imageDialogRevision = modalRevision;
  bindLocalDocumentImage({
    picker: $("#document-image"),
    input,
    active: () =>
      project === owner &&
      $("#dialog").open &&
      modalRevision === imageDialogRevision &&
      (!workspaceOwner || workspaceDocument() === workspaceOwner) &&
      (index === undefined || project.documents[index] === existing),
    notify: toast,
  });
  preview.innerHTML = renderMarkdown(input.value);
}

function sessionLabel() {
  const label =
    {
      idle: "未连接",
      starting: "连接请求中",
      active: "会话已建立",
      sending: "正在提交消息",
      stopping: "正在断开",
      closed: "已关闭",
      "uncertain-start": "连接结果待核对",
      "uncertain-send": "发送结果待核对",
      "uncertain-stop": "断开结果待核对",
    }[sessionState.phase] || "待核对";
  return (
    (sessionState.phase === "active" ||
    (sessionState.phase === "closed" &&
      ["closed", "error"].includes(activeSession?.state))
      ? activeSession.state
      : label) + (sessionState.warning ? " · " + sessionState.warning : "")
  );
}
function showSession() {
  if ($("#session-status")) $("#session-status").textContent = sessionLabel();
  if ($("#session-events"))
    $("#session-events").textContent =
      activeSession?.events
        ?.map((event) => `${event.at} ${event.direction} ${event.data}`)
        .join("\n") || "";
  for (const [id, enabled] of [
    ["#session-connect", sessionState.canConnect],
    ["#session-send", sessionState.canSend],
    ["#session-stop", sessionState.canStop],
  ])
    if ($(id)) $(id).disabled = !enabled;
}
async function pollSession() {
  return sessionController.poll();
}

async function refreshMCPActivity() {
  if (!token || document.hidden) return;
  try {
    const poll = ++mcpPollSequence;
    const nextState = await api("/mcp/config");
    if (poll !== mcpPollSequence) return;
    mcpState = nextState;
    updateMCPPanel?.(mcpState);
    const running = (mcpState.activities || []).filter(
      (item) => item.status === "running",
    );
    const top = $("#mcp-status");
    if (top)
      top.textContent =
        "MCP · " +
        (running.length
          ? running.length + " 个任务运行中"
          : mcpState.enabled
            ? "已开启"
            : "未开启");
    const area = $("#mcp-plan-status");
    if (area)
      area.textContent = running
        .filter((item) => item.projectId === project?.id)
        .map(
          (item) =>
            item.tool +
            " · " +
            item.completed +
            (item.total ? "/" + item.total : "") +
            " 步",
        )
        .join("；");
  } catch {
    /* Status polling never discards an unsaved editor. */
  }
}
setInterval(refreshMCPActivity, 1000);

function editFunction(index) {
  const existing = project.settings?.functions?.[index];
  let tested = "";
  const read = () => ({
    ...(existing || {}),
    name: $("#function-name").value.trim(),
    kind: existing?.kind || (existing ? "script" : "transform"),
    body: $("#function-body").value,
  });
  const fingerprint = () =>
    JSON.stringify([read(), $("#function-input").value]);
  modal(
    existing ? "编辑自定义函数" : "新建自定义函数",
    `${existing?.apipostSource ? '<p class="notice">原版共享函数模式：可在脚本中直接调用fn_名称；同步异常返回text输入，不代表函数全部语义兼容。来源元数据会保留。</p>' : ""}<label>函数名称</label><input id="function-name" value="${esc(existing?.name || "")}" ${existing ? "disabled" : ""}><label>函数主体（${existing && existing.kind !== "transform" ? "args 数组" : "text 输入值"}）</label><textarea id="function-body"></textarea><label>测试输入（JSON）</label><textarea id="function-input">"示例"</textarea><button id="test-function" type="button">测试函数</button><pre id="function-result">尚未测试</pre>`,
    async () => {
      const fn = read();
      if (!tested || tested !== fingerprint())
        throw Error("请先测试当前函数代码和输入");
      const previous = [...(project.settings?.functions || [])];
      if (previous.some((item, i) => i !== index && item.name === fn.name))
        throw Error("函数名称已存在");
      project.settings ??= {};
      project.settings.functions = [...previous];
      if (index === undefined) project.settings.functions.push(fn);
      else project.settings.functions[index] = fn;
      mark();
      try {
        await save();
      } catch (error) {
        rollbackProjectSave(error, () => {
          project.settings.functions = previous;
        });
        throw error;
      }
      if (index === undefined) index = project.settings.functions.length - 1;
    },
  );
  $("#function-body").value = existing?.body || "return text;";
  $("#test-function").onclick = async () => {
    const stamp = fingerprint();
    tested = "";
    const button = $("#test-function");
    const output = $("#function-result");
    button.disabled = true;
    try {
      const result = await api(
        "/projects/" + project.id + "/function-preview",
        "POST",
        {
          function: read(),
          value: JSON.parse($("#function-input").value),
        },
      );
      if (stamp !== fingerprint())
        throw Error("测试期间内容已更改，请重新测试");
      tested = stamp;
      output.textContent =
        JSON.stringify(result.value, null, 2) +
        (result.logs.length ? "\n日志：\n" + result.logs.join("\n") : "");
    } catch (error) {
      output.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}

function editDynamicValue(group, index) {
  const target = request();
  const editor = $("#body-code");
  const selection = {
    start: editor?.selectionStart || 0,
    end: editor?.selectionEnd || 0,
  };
  collect();
  const bodyId = group === "body" ? index || uid() : undefined;
  const row =
    group === "body"
      ? { dynamic: target.bodyDynamic?.[bodyId] }
      : target[group][index];
  if (row.type === "file") {
    toast("文件参数不能配置动态文本值");
    return;
  }
  const initial = row.dynamic || {
    source: "fixed",
    value: row.value || "",
    functions: [],
  };
  const read = () => ({
    source: $("#dynamic-source").value,
    value:
      $("#dynamic-source").value === "fixed"
        ? JSON.parse($("#dynamic-value").value)
        : $("#dynamic-value").value,
    ...(group === "body" ? { format: $("#dynamic-format").value } : {}),
    ...($("#dynamic-source").value === "mock"
      ? {
          type: $("#dynamic-mock-type").value,
          ...($("#dynamic-seed").value.trim()
            ? { seed: Number($("#dynamic-seed").value) }
            : {}),
        }
      : {}),
    functions: $("#dynamic-functions")
      .value.split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  });
  modal(
    "动态参数值",
    `<p>预览使用当前环境值；发送时会重新读取前置脚本运行后的值。固定值输入JSON，变量输入变量名。处理函数按逗号分隔顺序执行。</p><label>来源</label><select id="dynamic-source"><option value="fixed">固定值</option><option value="variable">变量</option><option value="mock">Mock样例</option><option value="apipost-function">原版函数模板（Query受限子集）</option><option value="apipost-header-function">原版函数模板（Header受限子集）</option><option value="apipost-form-function">原版函数模板（表单文本受限子集）</option><option value="apipost-body-function">原版函数模板（完整正文受限子集）</option></select><p>原版函数模板仅支持匹配位置的Query/Header/表单文本表达式或整个raw/JSON正文，支持原样函数参数、安全点路径变量或引号原文起始；首函数抛错保留首段模板，后续抛错保留上一步值。支持无参数fn_及lower/upper/length/number及concat/lconcat原文拼接、substr有界整数截取、padstart/padend有界填充及URI编解码加工链；MD5/SHA、Base64文本及ISO日期加工暂不能与共享函数混用；允许响应后置脚本及仅改变量的前置脚本；禁止前置请求修改、SDK模式及额外原生加工链，Header/表单/正文允许前后缀及多个白名单变量/原文表达式（多表达式不支持共享函数），Query仍须单个完整表达式；结果不再次插值。</p><label>输入值 / 变量名 / Mock表达式</label><textarea id="dynamic-value"></textarea><details><summary>Mock类型与种子</summary><p>支持 @cname()、@email()、@integer(min,max) 等有界表达式，不是完整Faker/Mock.js。种子留空每次重新生成；填写整数可复现。预览不代表下次随机结果。</p><select id="dynamic-mock-type">${["string", "integer", "number", "boolean", "object", "array"].map((type) => `<option>${type}</option>`).join("")}</select><input id="dynamic-seed" type="number" placeholder="随机种子（可选）"></details>${group === "body" ? '<label>输出方式</label><select id="dynamic-format"><option value="json">JSON值（自动转义/引号）</option><option value="text">原始文本</option></select>' : ""}<label>处理函数</label><input id="dynamic-functions" list="dynamic-function-list"><datalist id="dynamic-function-list">${(project.settings?.functions || []).map((fn) => `<option value="${esc(fn.name)}"></option>`).join("")}</datalist><button id="dynamic-preview" type="button">预览</button><button id="dynamic-remove" type="button">移除动态值</button><pre id="dynamic-result">尚未预览</pre>`,
    () => {
      const spec = read();
      if (isApipostFunctionSource(spec.source)) {
        if (group !== apipostFunctionSourceGroups[spec.source])
          throw Error("原版函数模板来源与参数位置不匹配");
        const parsed = parseApipostFunctionTemplate(spec.value);
        if (
          group === "query" &&
          (parsed.fieldExpression || parsed.fieldExpressions)
        )
          throw Error("原版Query模板暂不支持表达式前后缀");
        if (spec.source === "apipost-body-function" && spec.format !== "text")
          throw Error("原版正文函数模板须选择原文输出");
        if (spec.functions.length)
          throw Error("原版函数模板暂不支持额外加工链");
      }
      if (group === "body") {
        target.bodyDynamic ??= {};
        target.bodyDynamic[bodyId] = spec;
        if (!index)
          target.body =
            target.body.slice(0, selection.start) +
            "{{@value:" +
            bodyId +
            "}}" +
            target.body.slice(selection.end);
      } else row.dynamic = spec;
      mark();
      render();
    },
  );
  if (group === "body") $("#dynamic-format").value = initial.format || "json";
  $("#dynamic-mock-type").value = initial.type || "string";
  $("#dynamic-seed").value = initial.seed ?? "";
  $("#dynamic-source").value = initial.source;
  $("#dynamic-value").value =
    initial.source === "fixed" ? JSON.stringify(initial.value) : initial.value;
  $("#dynamic-functions").value = (initial.functions || []).join(", ");
  const updateSourceFormat = () => {
    if (group !== "body") return;
    const sourceBody = $("#dynamic-source").value === "apipost-body-function";
    $("#dynamic-format").disabled = sourceBody;
    if (sourceBody) $("#dynamic-format").value = "text";
  };
  $("#dynamic-source").onchange = updateSourceFormat;
  updateSourceFormat();
  $("#dynamic-preview").onclick = async () => {
    const output = $("#dynamic-result");
    try {
      const result = await api(
        "/projects/" + project.id + "/dynamic-preview",
        "POST",
        {
          spec: read(),
          functions: project.settings?.functions || [],
        },
      );
      output.textContent = JSON.stringify(result.value, null, 2);
    } catch (error) {
      output.textContent = error.message;
    }
    if (output.isConnected && $("#dialog").open) {
      const content = $("#dialog-content");
      content.scrollTop = content.scrollHeight;
    }
  };
  $("#dynamic-remove").onclick = () => {
    if (group === "body") {
      delete target.bodyDynamic?.[bodyId];
      target.body = target.body.split("{{@value:" + bodyId + "}}").join("");
    } else delete row.dynamic;
    mark();
    $("#dialog").close();
    render();
  };
}

async function openCookieManager(workspace = null) {
  collect();
  const owner = project,
    environmentId = env(),
    endpoint = "/projects/" + owner.id + "/cookies";
  const dialog = $("#dialog");
  const loading = '<p role="status">正在读取Cookie…</p>';
  modal(
    "Cookie管理器",
    workspace
      ? environmentDialogShell(owner, {
          workspace: true,
          section: "cookies",
          content: `<section class="environment-dialog-main environment-cookie-content" aria-label="当前执行环境的Cookie">${loading}</section>`,
        })
      : loading,
    () => {},
    "完成",
  );
  const revision = modalRevision;
  const content = workspace
    ? $(".environment-cookie-content")
    : $("#dialog-content");
  const active = () =>
    dialog.open &&
    modalRevision === revision &&
    owner === project &&
    environmentId === env() &&
    content.isConnected;
  if (workspace) {
    workspace.bindNavigation(workspace);
    $('[data-env-section="cookies"]')?.focus();
  }
  let state;
  try {
    state = await api(
      endpoint + "?environmentId=" + encodeURIComponent(environmentId),
    );
  } catch (error) {
    if (active()) content.textContent = "读取Cookie失败：" + error.message;
    return;
  }
  if (!active()) return;
  const attempt = (fn) => async () => {
    if (!active()) return;
    try {
      await fn();
    } catch (error) {
      if (!active()) return;
      $("#cookie-error").textContent = error.message;
      content.scrollTop = 0;
    }
  };
  const change = async (data) => {
    state = await api(endpoint, "POST", {
      environmentId,
      expectedRevision: state.revision,
      ...data,
    });
    draw();
  };
  const draw = () => {
    if (!active()) return;
    content.innerHTML = cookieManagerHTML(state, {
      workspace: Boolean(workspace),
    });
    content.scrollTop = 0;
    for (const button of content.querySelectorAll("button"))
      button.type = "button";
    $("#cookie-toggle").onclick = attempt(() =>
      change({ operation: "configure", enabled: !state.enabled }),
    );
    $("#cookie-refresh").onclick = attempt(async () => {
      state = await api(
        endpoint + "?environmentId=" + encodeURIComponent(environmentId),
      );
      draw();
    });
    $("#cookie-clear").onclick = attempt(async () => {
      if (confirm("清空当前环境的全部Cookie？"))
        await change({ operation: "clear" });
    });
    $("#cookie-set").onclick = attempt(() =>
      change({
        operation: "set",
        url: $("#cookie-url").value,
        cookie: $("#cookie-line").value,
      }),
    );
    for (const button of content.querySelectorAll("[data-cookie-remove]"))
      button.onclick = attempt(async () => {
        const c = state.cookies[Number(button.dataset.cookieRemove)];
        if (confirm("删除此Cookie？"))
          await change({
            operation: "remove",
            domain: c.domain,
            path: c.path,
            key: c.key,
          });
      });
    for (const button of content.querySelectorAll("[data-cookie-edit]"))
      button.onclick = () => {
        if (!active()) return;
        const editor = content.querySelector("#environment-cookie-add");
        if (editor) editor.open = true;
        const c = state.cookies[Number(button.dataset.cookieEdit)];
        $("#cookie-url").value =
          "https://" +
          (c.domain.includes(":") ? "[" + c.domain + "]" : c.domain) +
          c.path;
        $("#cookie-line").value =
          c.key +
          "=" +
          c.value +
          "; Path=" +
          c.path +
          (c.hostOnly ? "" : "; Domain=" + c.domain) +
          (c.secure ? "; Secure" : "") +
          (c.httpOnly ? "; HttpOnly" : "") +
          (c.sameSite ? "; SameSite=" + c.sameSite : "") +
          (c.expires && c.expires !== "Infinity"
            ? "; Expires=" + new Date(c.expires).toUTCString()
            : "") +
          (c.maxAge !== undefined ? "; Max-Age=" + c.maxAge : "");
      };
  };
  draw();
}

function insertVariable(name) {
  const editor = $("#body-code");
  if (!editor) return;
  const start = editor.selectionStart,
    end = editor.selectionEnd,
    helperScroll = $(".parameter-helper")?.scrollTop || 0;
  request().body =
    editor.value.slice(0, start) + "{{" + name + "}}" + editor.value.slice(end);
  mark();
  render();
  if ($(".parameter-helper")) $(".parameter-helper").scrollTop = helperScroll;
  const updated = $("#body-code");
  updated?.setSelectionRange(start + name.length + 4, start + name.length + 4);
  updated?.focus({ preventScroll: true });
}

function updateDatabaseFields() {
  const selector = $("#db-type");
  if (!selector) return;
  const type = selector.value;
  $("#db-tls").disabled = isPreviewDatabase(type);
  if (isPreviewDatabase(type)) $("#db-tls").checked = true;
  $("#db-sqlserver-notice").hidden = type !== "sqlserver";
  const defaults = {
    sqlserver: "SELECT id FROM dbo.items",
    oracle: "SELECT id FROM APP.ITEMS",
    dameng: "SELECT id FROM APP.ITEMS",

    sqlite: "SELECT name FROM sqlite_master WHERE type = 'table'",
    postgres: "SELECT 1 AS answer",
    mysql: "SELECT 1 AS answer",
    clickhouse: "SELECT 1 AS answer",
    redis: '["PING"]',
    mongodb: '{"collection":"items","filter":{},"limit":100}',
  };
  const previous = selector.dataset.previousType;
  const tls = String($("#db-tls").checked);
  if (previous && (previous !== type || selector.dataset.previousTLS !== tls)) {
    $("#db-client-key").value = "";
    $("#db-client-cert").value = "";
    if ($("#db-sql").value === defaults[previous])
      $("#db-sql").value = defaults[type];
    $("#db-result").textContent = "";
    $("#db-result").activeQuery = null;
    $("#db-query").disabled = false;
  }
  selector.dataset.previousType = type;
  selector.dataset.previousTLS = tls;
  $("#db-sql").previousElementSibling.textContent =
    type === "redis"
      ? "Redis命令JSON数组"
      : type === "mongodb"
        ? "MongoDB查询JSON"
        : "SQL";

  const show = (id, visible) => {
    const input = $(id);
    input.style.display = visible ? "" : "none";
    input.previousElementSibling.style.display = visible ? "" : "none";
  };
  for (const id of [
    "#db-host",
    "#db-port",
    "#db-user",
    "#db-password",
    "#db-name",
    "#db-tls",
  ])
    show(id, type !== "sqlite");
  show("#db-path", type === "sqlite");
  $("#db-write-label").hidden = !["sqlite", "postgres", "redis"].includes(type);
  $("#db-write-description").textContent =
    type === "postgres"
      ? "仅本次允许 PostgreSQL 写入（单条 DML，无 RETURNING）"
      : type === "redis"
        ? "仅本次允许 Redis SET（单键，不能回滚）"
        : "仅本次允许SQLite写入（INSERT / UPDATE / DELETE）";
  $("#db-write").checked = false;
  $("#db-query").textContent =
    type === "sqlite" && $("#db-write").checked
      ? "确认并执行写入"
      : "执行只读查询";
  show("#db-params", !["redis", "mongodb"].includes(type));
  show("#db-auth-source", type === "mongodb");
  show("#db-ca", type !== "sqlite" && $("#db-tls").checked);
  show("#db-name", !["sqlite", "dameng"].includes(type));
  show("#db-server-dn", type === "oracle");
  show("#db-client-cert", type === "dameng");
  show("#db-client-key", type === "dameng");
  show("#db-relations", type === "oracle" || type === "dameng");
  $("#db-ca").placeholder =
    type === "dameng"
      ? "服务器信任根 CA（PEM，必填）"
      : "留空使用系统信任的证书";
  $("#db-params").previousElementSibling.textContent =
    type === "sqlserver"
      ? "绑定参数 JSON（@p0、@p1；int64/decimal 请用显式类型对象）"
      : type === "clickhouse"
        ? "绑定参数JSON数组（{p0:String}、{p1:UInt64}）或命名对象"
        : "绑定参数 JSON";
  $("#db-port").placeholder =
    type === "oracle"
      ? "2484"
      : type === "dameng"
        ? "5236"
        : type === "sqlserver"
          ? "1433（留空使用默认）"
          : type === "clickhouse"
            ? $("#db-tls").checked
              ? "8443"
              : "8123"
            : type === "redis"
              ? "6379"
              : type === "mongodb"
                ? "27017"
                : type === "mysql"
                  ? "3306"
                  : "5432";
}
