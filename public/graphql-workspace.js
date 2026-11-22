import { prepareGraphQLEdit, readGraphQLEditor } from "./graphql-editor.js";
import {
  bindGraphQLSchemaDirectory,
  graphQLSchemaDirectoryHTML,
} from "./graphql-schema-directory.js";

export const unappliedGraphQL =
  "GraphQL 编辑有未应用的更改。请先回到对应接口应用或放弃。";

export function createGraphQLWorkspaceDrafts() {
  const latest = new WeakMap();
  const open = new WeakSet();
  return {
    read(request) {
      const local = latest.get(request);
      if (local) return local;
      const view = readGraphQLEditor(request);
      return view && { view, original: request.body, patch: {} };
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
    edit(request, field, text) {
      const state = this.read(request);
      if (!state || state.original !== request.body)
        throw Error("GraphQL 正文已变化，未覆盖现有正文。");
      const baseline = (state.view[field] ?? "").replace(/\r\n?/g, "\n");
      if (text === baseline) delete state.patch[field];
      else
        state.patch[field] =
          field === "variablesSource" && text === "" ? undefined : text;
      if (Object.keys(state.patch).length) latest.set(request, state);
      else latest.delete(request);
    },
    apply(request) {
      const state = latest.get(request);
      if (!state) return false;
      if (state.original !== request.body)
        throw Error("GraphQL 正文已变化，未覆盖现有正文。");
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
  const opened = data && drafts.variablesOpen(request);
  const pending = data && drafts.pending(request);
  const value = (key) =>
    Object.hasOwn(data.patch, key)
      ? (data.patch[key] ?? "")
      : (data.view[key] ?? "");
  return `<section class="graphql-workspace" data-graphql-owner="${esc(ownerId + ":" + request.id)}" aria-label="GraphQL 请求编辑">
    ${
      data
        ? `<div class="graphql-editor-layout">${graphQLSchemaDirectoryHTML()}<div class="graphql-panes${opened ? " variables-open" : ""}">
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
      <div class="graphql-draft-actions"${pending ? "" : " hidden"}>
        <button type="button" id="graphql-discard" class="ghost">放弃</button><button type="button" id="graphql-apply" class="primary">应用到正文</button>
      </div>
      <span class="muted">以 HTTP POST 发送 JSON${data.view.operationName === undefined ? "" : " · 保留现有操作名"}</span>
      <button type="button" id="graphql-detach" class="ghost">使用原始 HTTP 正文</button>
    </div>`
        : `<p class="notice">该正文无法用 Query / Variables 无损编辑，未修改原有内容。</p>
    <button type="button" id="graphql-detach" class="ghost">使用原始 HTTP 正文</button>`
    }
    <p class="graphql-error" role="alert"></p>
  </section>`;
}

export function bindGraphQLWorkspace(
  root,
  { request, drafts, directory, owns, revised, redraw, changed, detach },
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
  const fieldControls = root.querySelector(".graphql-draft-actions");
  for (const field of root.querySelectorAll("[data-graphql-field]")) {
    field.addEventListener("input", () =>
      attempt(() => {
        drafts.edit(request, field.dataset.graphqlField, field.value);
        revised();
        fieldControls.hidden = !drafts.pending(request);
      }),
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
  root.querySelector("#graphql-detach").addEventListener("click", () =>
    attempt(() => {
      if (drafts.pending(request)) throw Error(unappliedGraphQL);
      detach();
    }),
  );
}
