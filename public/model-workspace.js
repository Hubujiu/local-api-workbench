import { modelFolderPath } from "./model-folders.js";
import { assertModelSchema } from "./model-edit.js";
import {
  ModelWorkspaceTree,
  modelWorkspaceTree,
} from "./model-workspace-tree.js";

const blankSchema = { type: "object", properties: {} };
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export class WorkspaceModelDrafts {
  #drafts = new Map();

  get(projectId) {
    return this.#drafts.get(projectId);
  }

  open(projectId) {
    if (!this.get(projectId)) {
      const initialSchema = structuredClone(blankSchema);
      this.#drafts.set(projectId, {
        active: false,
        name: "",
        folderId: "",
        schema: initialSchema,
        tree: new ModelWorkspaceTree(),
        get changed() {
          return Boolean(
            this.name ||
              this.folderId ||
              this.schema !== initialSchema ||
              this.tree.changed,
          );
        },
        replaceSchema(schema) {
          assertModelSchema(schema);
          this.schema = structuredClone(schema);
        },
      });
    }
    const draft = this.get(projectId);
    draft.active = true;
    return draft;
  }

  finish(projectId, draft) {
    if (this.get(projectId) !== draft) return false;
    return this.#drafts.delete(projectId);
  }
}

export function modelDraftTab(draft) {
  if (!draft) return "";
  return `<button class="ghost model-draft-tab" type="button" data-open-model-workspace${draft.active ? ' aria-current="page"' : ""}><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor"><circle cx="8" cy="4" r="2"/><circle cx="4" cy="11" r="2"/><circle cx="12" cy="11" r="2"/><path d="M7 6L5 9m4-3 2 3"/></svg>模型草稿</button>`;
}

export function modelDraftPanel(project, draft) {
  const folders = project.modelFolders || [];
  const options = folders
    .map(
      (folder) =>
        `<option value="${esc(folder.id)}"${draft.folderId === folder.id ? " selected" : ""}>${esc(modelFolderPath(folders, folder.id))}</option>`,
    )
    .join("");
  const missingFolder =
    draft.folderId && !folders.some((folder) => folder.id === draft.folderId);
  return `<section class="workspace-model-draft" aria-label="数据模型草稿"><div class="model-draft-header"><input id="model-workspace-name" aria-label="模型名称" placeholder="输入模型名称，建议使用代码模型名称或其同义词" value="${esc(draft.name)}" maxlength="500"><div class="model-workspace-actions"><button type="button" id="model-workspace-discard">放弃草稿</button><button type="button" id="model-workspace-apply" class="primary">应用到项目草稿</button></div></div><div class="model-draft-location"><label>模型目录 <select id="model-workspace-folder"><option value="">根目录</option>${missingFolder ? `<option value="${esc(draft.folderId)}" selected>原目录已不存在，请重新选择</option>` : ""}${options}</select></label><button type="button" class="ghost" id="model-workspace-list">返回字典</button></div><section class="model-draft-schema" aria-labelledby="model-draft-schema-heading"><header><h2 id="model-draft-schema-heading">数据结构</h2><button class="ghost" type="button" id="model-workspace-raw">Raw编辑</button></header>${modelWorkspaceTree(draft)}</section><p class="muted model-draft-help">应用后仍是本地草稿；使用「保存项目」写入磁盘。</p></section>`;
}
