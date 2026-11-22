import { prepareGraphQLEdit, readGraphQLEditor } from "./graphql-editor.js";
import {
  bindGraphQLNamedRail,
  graphqlNamedRailHTML,
} from "./graphql-named-workspace.js";
import {
  bindGraphQLSchemaDirectory,
  graphQLSchemaDirectoryHTML,
} from "./graphql-schema-directory.js";

export const unappliedGraphQL =
  "GraphQL 编辑有未应用的更改。请先回到对应接口应用或放弃。";

const currentNamedQuery = (request) => request.graphqlNamedQueries?.activeId;
const rawCollectionNotice =
  "此接口包含命名查询，不能直接切换为原始 HTTP 正文。可将当前查询复制到独立 HTTP 接口。";

export function createGraphQLWorkspaceDrafts() {
  const latest = new WeakMap();
  const open = new WeakSet();
  const operationDetails = new WeakSet();
  return {
    read(request) {
      const local = latest.get(request);
      if (local) return local;
      const view = readGraphQLEditor(request);
      return (
        view && {
          view,
          original: request.body,
          named: currentNamedQuery(request),
          patch: {},
        }
      );
    },
    pending(request) {
      return Boolean(request && latest.has(request));
    },
    hasProject(project) {
      return project?.requests?.some((request) => latest.has(request)) ?? false;
    },
    variablesOpen: (request) => open.has(request),
    showVariables(request, show) {
      if (show) open.add(request);
      else open.delete(request);
    },
    operationOpen: (request) => operationDetails.has(request),
    showOperation(request, show) {
      if (show) operationDetails.add(request);
      else operationDetails.delete(request);
    },
    edit(request, field, text) {
      const state = this.read(request);
      if (
        !state ||
        state.original !== request.body ||
        state.named !== currentNamedQuery(request)
      )
        throw Error("GraphQL 正文已变化，未覆盖现有正文。");
      if (field === "operationName") {
        if (text === state.view.operationName) delete state.patch.operationName;
        else state.patch.operationName = text;
      } else {
        const baseline = (state.view[field] ?? "").replace(/\r\n?/g, "\n");
        if (text === baseline) delete state.patch[field];
        else
          state.patch[field] =
            field === "variablesSource" && text === "" ? undefined : text;
      }
      if (Object.keys(state.patch).length) latest.set(request, state);
      else latest.delete(request);
    },
    apply(request) {
      const state = latest.get(request);
      if (!state) return false;
      if (
        state.original !== request.body ||
        state.named !== currentNamedQuery(request)
      )
        throw Error("GraphQL 正文已变化，未覆盖现有正文。");
      // Validate only the explicitly edited identifier, not the Query document
      // or an untouched historical string.
      const operationName = state.patch.operationName;
      if (
        operationName !== undefined &&
        (!/^[A-Za-z_]/.test(operationName) ||
          /[^A-Za-z0-9_]/.test(operationName))
      )
        throw Error(
          "操作名称须以英文字母或下划线开头，只能包含英文字母、数字或下划线；也可取消包含该字段。",
        );
      const next = prepareGraphQLEdit(request, state.patch);
      latest.delete(request);
      if (next === request.body) return false;
      request.body = next;
      return true;
    },
    discard: (request) => latest.delete(request),
  };
}

export function graphqlWorkspaceHTML(request, drafts, esc, ownerId) {
  const data = drafts.read(request);
  const fallback = request.graphqlNamedQueries
    ? `<span class="muted">${rawCollectionNotice}</span>`
    : '<button type="button" id="graphql-detach" class="ghost">使用原始 HTTP 正文</button>';
  const opened = data && drafts.variablesOpen(request);
  const pending = data && drafts.pending(request);
  const operation =
    data &&
    (Object.hasOwn(data.patch, "operationName")
      ? data.patch.operationName
      : data.view.operationName);
  const includesOperation = operation !== undefined;
  const value = (key) =>
    Object.hasOwn(data.patch, key)
      ? (data.patch[key] ?? "")
      : (data.view[key] ?? "");
  return `<section class="graphql-workspace" data-graphql-owner="${esc(JSON.stringify([ownerId, request.id, currentNamedQuery(request)]))}" aria-label="GraphQL 请求编辑">
    ${
      data
        ? `<div class="graphql-editor-layout">${graphqlNamedRailHTML(request, esc)}${graphQLSchemaDirectoryHTML()}<div class="graphql-panes${opened ? " variables-open" : ""}">
      <label class="graphql-source">
        <span>Query</span><textarea id="graphql-query" data-graphql-field="query" spellcheck="false" wrap="off">
${esc(value("query"))}</textarea>
      </label>
      <button id="graphql-variables-toggle" class="graphql-variables-toggle" type="button" aria-expanded="${Boolean(opened)}" aria-controls="graphql-variables-pane"><span aria-hidden="true">⌃</span>Variables</button>
      <label id="graphql-variables-pane" class="graphql-source"${opened ? "" : " hidden"}>
        <span>Variables <small id="graphql-variables-hint">JSON 对象或 null；清空则省略</small></span><textarea id="graphql-variables" aria-label="Variables" aria-describedby="graphql-variables-hint" data-graphql-field="variablesSource" spellcheck="false" wrap="off">
${esc(value("variablesSource"))}</textarea>
      </label>
    </div></div>
    <div class="graphql-workspace-actions">
      <details class="graphql-operation-name"${drafts.operationOpen(request) ? " open" : ""}>
        <summary>操作名称（可选）</summary>
        <div>
          <label><input type="checkbox" id="graphql-include-operation-name"${includesOperation ? " checked" : ""}>包含 operationName</label>
          <label for="graphql-operation-name">操作名称</label>
          <input type="text" id="graphql-operation-name" autocomplete="off" spellcheck="false" value="${esc(operation ?? data.view.operationName ?? "")}" aria-describedby="graphql-operation-name-hint"${includesOperation ? "" : " disabled"}>
          <small id="graphql-operation-name-hint" class="muted">手动指定要执行的操作。取消包含会省略该字段。</small>
        </div>
      </details>
      <div class="graphql-draft-actions"${pending ? "" : " hidden"}>
        <button type="button" id="graphql-discard" class="ghost">放弃</button><button type="button" id="graphql-apply" class="primary">应用到正文</button>
      </div>
      <span class="muted">以 HTTP POST 发送 JSON</span>
      ${fallback}
    </div>`
        : `<p class="notice">该正文无法用 Query / Variables 无损编辑，未修改原有内容。</p>
    ${fallback}`
    }
    <p class="graphql-error" role="alert"></p>
  </section>`;
}

export function bindGraphQLWorkspace(
  root,
  { request, drafts, directory, named, owns, revised, redraw, changed, detach },
) {
  const query = root.querySelector("#graphql-query");
  const error = root.querySelector(".graphql-error");
  const active = () => root.isConnected && owns();
  const schema = root.querySelector(".graphql-schema-directory");
  if (schema)
    bindGraphQLSchemaDirectory(schema, { request, directory, owns: active });
  const attempt = (fn) => {
    if (!active()) return;
    try {
      error.textContent = "";
      fn();
    } catch (cause) {
      error.textContent = cause.message;
    }
  };
  const rail = root.querySelector(".graphql-named-rail");
  if (rail)
    bindGraphQLNamedRail(rail, {
      active,
      add: (keyboard) => attempt(() => named.add(keyboard)),
      select: (id, keyboard) => attempt(() => named.select(id, keyboard)),
      arrange: (type, id) => attempt(() => named.arrange(type, id)),
    });
  const fieldControls = root.querySelector(".graphql-draft-actions");
  const operationDetails = root.querySelector(".graphql-operation-name");
  const includeOperation = root.querySelector(
    "#graphql-include-operation-name",
  );
  const operation = root.querySelector("#graphql-operation-name");
  const initialName = operation ? drafts.read(request) : null;
  let operationCandidate =
    initialName?.patch.operationName ?? initialName?.view.operationName;
  operationDetails?.addEventListener("toggle", () => {
    if (active()) drafts.showOperation(request, operationDetails.open);
  });
  const stage = (field, value) => {
    drafts.edit(request, field, value);
    revised();
    fieldControls.hidden = !drafts.pending(request);
  };
  includeOperation?.addEventListener("change", () =>
    attempt(() => {
      operation.disabled = !includeOperation.checked;
      stage(
        "operationName",
        includeOperation.checked
          ? (operationCandidate ?? operation.value)
          : undefined,
      );
    }),
  );
  operation?.addEventListener("input", () =>
    attempt(() => {
      if (operation.disabled) return;
      operationCandidate = operation.value;
      stage("operationName", operationCandidate);
    }),
  );
  for (const field of root.querySelectorAll("[data-graphql-field]")) {
    field.addEventListener("input", () =>
      attempt(() => stage(field.dataset.graphqlField, field.value)),
    );
  }
  const toggle = root.querySelector("#graphql-variables-toggle");
  toggle?.addEventListener("click", () =>
    attempt(() => {
      const opening = !drafts.variablesOpen(request);
      drafts.showVariables(request, opening);
      toggle.setAttribute("aria-expanded", String(opening));
      root
        .querySelector(".graphql-panes")
        .classList.toggle("variables-open", opening);
      root.querySelector("#graphql-variables-pane").hidden = !opening;
    }),
  );
  root.querySelector("#graphql-apply")?.addEventListener("click", () =>
    attempt(() => {
      if (drafts.apply(request)) changed();
      fieldControls.hidden = true;
      query.focus({ preventScroll: true });
    }),
  );
  root.querySelector("#graphql-discard")?.addEventListener("click", () =>
    attempt(() => {
      if (drafts.discard(request)) revised();
      redraw();
    }),
  );
  root.querySelector("#graphql-detach")?.addEventListener("click", () =>
    attempt(() => {
      if (drafts.pending(request)) throw Error(unappliedGraphQL);
      detach();
    }),
  );
}
