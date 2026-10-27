import { verifyApipostDocumentDefinitions } from "./apipost-document-export.mjs";
import { exportApipost, apipostExportId } from "./apipost-export.mjs";
import { importIntoProject, snapshotPlan } from "./core.mjs";
import { directorySettings } from "../public/apipost-directory-input.js";

// Definition interchange only. Never writes paths, starts the original app, or
// turns source task metadata into live API/step execution.
export function exportApipostDirectory(project, options = {}) {
  const plans = project.plans || [];
  if (!Array.isArray(plans) || plans.length > 50)
    throw Error("原生目录导出最多50个计划");
  const base = { ...project, plans: [] };
  const document = exportApipost(base, options);
  const projectId = document.project_id;
  const scoped = (kind, value) =>
    apipostExportId(kind, projectId + "\0" + value);
  const timestamp =
    project.updatedAt || project.createdAt || new Date().toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) throw Error("原生目录时间无效");
  const folders = new Map();
  const mapNode = (node) => {
    const copy = structuredClone(node);
    copy.target_id = scoped(
      copy.target_type === "folder"
        ? "f"
        : copy.target_type === "doc"
          ? "d"
          : "a",
      node.target_id,
    );
    copy.parent_id = node.parent_id === "0" ? "0" : scoped("f", node.parent_id);
    if (node.mark_id) copy.mark_id = scoped("m", node.mark_id);
    for (const phase of ["pre_tasks", "post_tasks"])
      for (const [i, task] of (copy.request?.[phase] || []).entries())
        task.id = scoped("t", copy.target_id + ":" + phase + ":" + i);
    for (const [i, example] of (copy.response?.example || []).entries())
      example.example_id = scoped("example", copy.target_id + ":" + i);
    if (copy.ai_expect) {
      for (const [i, rule] of copy.ai_expect.list.entries()) {
        rule.example.example_id = scoped(
          "mock-example",
          copy.target_id + ":rule:" + i,
        );
        for (const [j, condition] of rule.conditions.entries())
          condition.conditionId = scoped(
            "mock-condition",
            copy.target_id + ":" + i + ":" + j,
          );
      }
      copy.ai_expect.none_math_example.example_id = scoped(
        "mock-example",
        copy.target_id + ":fallback",
      );
    }
    return copy;
  };
  const apis = document.apis.map(mapNode);
  for (const node of apis)
    if (node.target_type === "folder") folders.set(node.target_id, node);
  const environments = document.global.envs.map((env) => ({
    ...env,
    env_id: scoped("e", env.env_id),
    project_id: projectId,
    created_at: timestamp,
    updated_at: timestamp,
  }));
  const envMap = new Map(
    project.environments.map((env, i) => [env.id, environments[i].env_id]),
  );
  const flowIds = new Set();
  let totalSteps = 0;
  const flows = plans.map((input) => {
    if (
      input.steps?.some(
        (step) => step.type !== undefined && step.type !== "http",
      )
    )
      throw Error("原生目录计划仅支持HTTP步骤");
    const plan = snapshotPlan(input);
    if (!plan.id || flowIds.has(plan.id))
      throw Error("原生目录计划标识重复或缺失");
    flowIds.add(plan.id);
    if (plan.statusPolicy !== "strict200" || plan.functions.length)
      throw Error("原生目录计划仅支持strict200和无共享函数快照");
    if (!envMap.has(plan.environmentId))
      throw Error("原生目录计划必须绑定明确环境");
    if ((totalSteps += plan.steps.length) > 200)
      throw Error("原生目录计划合计最多200步");
    const stepIds = new Set();
    const steps = plan.steps.map((step) => {
      if (
        step.type ||
        !step.enabled ||
        (step.expectedStatus !== undefined && step.expectedStatus !== 200)
      )
        throw Error("原生目录计划仅支持启用的HTTP步骤与严格200状态");
      if (!step.id || stepIds.has(step.id))
        throw Error("原生目录步骤标识重复或缺失");
      stepIds.add(step.id);
      const request = step.request;
      if (step.name !== request.name)
        throw Error("原生目录不能分别保留步骤名与快照接口名；请使用项目备份");
      if (
        (request.beforeScript || request.afterScript) &&
        request.scriptDialect !== "apipost8"
      )
        throw Error("原生目录步骤脚本须为Apipost方言");
      if (request.importedNativeTaskSource !== undefined)
        throw Error("原生目录尚不支持数据库混合任务来源往返；请使用项目备份");
      const source = request.importedScriptTasks;
      const snapshotRequest = { ...request, beforeScript: "", afterScript: "" };
      delete snapshotRequest.importedScriptTasks;
      // Reuse all HTTP/auth/URL/body rejection guards without confusing inert
      // API source code with the step's actual executable code.
      const frozen = exportApipost(
        { ...base, requests: [snapshotRequest] },
        options,
      );
      for (const folder of frozen.apis.filter(
        (n) => n.target_type === "folder",
      )) {
        const mapped = mapNode(folder);
        if (!folders.has(mapped.target_id))
          throw Error(
            "原生目录快照引用非活动目录，不能重新创建已删除或移动的目录；请使用项目备份",
          );
      }
      const api = mapNode(frozen.apis.find((n) => n.target_type === "api"));
      api.target_id = scoped("snapshot", plan.id + "\0" + step.id);
      for (const [i, example] of (api.response?.example || []).entries())
        example.example_id = scoped("example", api.target_id + ":" + i);
      for (const [phase, field] of [
        ["before", "pre_tasks"],
        ["after", "post_tasks"],
      ]) {
        api.request[field] = (source?.[phase] || []).map((task, i) => {
          if (task.origin || task.type !== "customScript")
            throw Error("原生目录尚不支持继承作用域或数据库任务来源");
          return {
            ...task,
            id: scoped("t", api.target_id + ":" + phase + ":" + i),
          };
        });
      }
      return {
        step_id: scoped("step", plan.id + "\0" + step.id),
        target_id: api.target_id,
        api_snapshot: api,
        input: {},
        pre_script: request.beforeScript,
        post_script: request.afterScript,
      };
    });
    if (
      ![plan.createdAt, plan.updatedAt].every((value) =>
        Number.isFinite(Date.parse(value)),
      )
    )
      throw Error("原生目录计划时间无效");
    return {
      project_id: projectId,
      flow_id: scoped("flow", plan.id),
      name: plan.name,
      description: plan.description,
      environment_id: envMap.get(plan.environmentId),
      source: plan.source,
      created_at: plan.createdAt,
      updated_at: plan.updatedAt,
      steps,
    };
  });
  const files = [];
  const put = (path, value) =>
    files.push({ path, text: JSON.stringify(value, null, 2) + "\n" });
  put("project.json", {
    project_id: projectId,
    name: document.name,
    intro: document.intro,
    created_at: timestamp,
    updated_at: timestamp,
  });
  const apiMetadata = (node) =>
    Object.fromEntries(
      [
        "target_id",
        "project_id",
        "parent_id",
        "target_type",
        "name",
        "sort",
        "method",
        "url",
        "mark_id",
        "status",
        "version",
      ]
        .filter((key) => Object.hasOwn(node, key))
        .map((key) => [key, node[key]]),
    );
  put("apis/index.json", {
    project_id: projectId,
    items: apis.map(apiMetadata),
  });
  for (const node of apis) {
    if (node.ai_expect !== undefined) {
      const config = { project_id: projectId, target_id: node.target_id };
      for (const key of [
        "ai_expect",
        "mock_server_enable",
        "mock_ip_white_list_enable",
        "mock_ip_white_list",
        "mock_show_target_id",
      ]) {
        config[key] = node[key];
        delete node[key];
      }
      put("settings/mock_" + node.target_id + ".json", config);
    }
    put("apis/" + node.target_id + ".json", {
      ...apiMetadata(node),
      created_at: timestamp,
      updated_at: timestamp,
      data: node,
    });
  }
  put("envs/index.json", {
    project_id: projectId,
    items: environments.map(({ env_id, name, sort }) => ({
      env_id,
      name,
      sort,
    })),
  });
  for (const env of environments) put("envs/" + env.env_id + ".json", env);
  put("global_vars.json", document.global.global_vars);
  put("global_params.json", document.global.global_param);
  for (const [file, key] of Object.entries(directorySettings)) {
    let value = document.global[key];
    if (key === "marks")
      value = value.map((mark) => ({
        ...mark,
        mark_id: scoped("m", mark.mark_id),
      }));
    put("settings/" + file + ".json", value);
  }
  put("samples/index.json", { project_id: projectId, items: [] });
  put("schemas/index.json", {
    project_id: projectId,
    items: document.models.map(({ schema, ...metadata }) => metadata),
  });
  for (const model of document.models)
    put("schemas/" + model.model_id + ".json", {
      model_id: model.model_id,
      project_id: projectId,
      name: model.name,
      data: model,
    });
  put("executions/flows/index.json", {
    version: 2,
    updated_at: timestamp,
    records: flows.map(({ steps, ...flow }) => ({
      ...flow,
      step_count: steps.length,
    })),
  });
  for (const flow of flows)
    put("executions/flows/" + flow.flow_id + ".json", flow);
  const result = { format: "apipost-offline-directory-v1", files };
  if (
    files.length > 5000 ||
    files.reduce(
      (size, file) => size + Buffer.byteLength(file.text) + file.path.length,
      0,
    ) >
      4 * 1024 * 1024
  )
    throw Error("原生目录导出超过5000文件或4MiB");
  // Pure detached conversion verifies the complete public import boundary. No
  // partial output is returned and no project, file, request or grant is mutated.
  const check = {
    requests: [],
    environments: [],
    servers: [],
    folders: [],
    settings: {},
    plans: [],
    cases: [],
    documents: [],
    dictionary: [],
  };
  importIntoProject(check, result, options);
  const withStatus = (p) =>
    (p.documents || []).map((d) => ({
      ...d,
      statusName: d.statusId
        ? p.settings?.statuses?.find((s) => s.id === d.statusId)?.name
        : undefined,
    }));
  verifyApipostDocumentDefinitions(withStatus(project), withStatus(check));
  if (check.plans.length !== plans.length)
    throw Error("原生目录计划回读不完整");
  for (const [i, plan] of check.plans.entries())
    for (const [j, step] of plan.steps.entries())
      if (
        step.request.beforeScript !== flows[i].steps[j].pre_script ||
        step.request.afterScript !== flows[i].steps[j].post_script
      )
        throw Error("原生目录步骤脚本回读不一致");
  return result;
}
