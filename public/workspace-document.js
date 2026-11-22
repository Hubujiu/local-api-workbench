import { markdownTools } from "./design-markdown.js";
import { renderMarkdown } from "./vendor/markdown-renderer.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

export function workspaceDocumentById(project, id) {
  if (typeof id !== "string" || !id) return null;
  const matches = (project?.documents || []).filter((doc) => doc.id === id);
  return matches.length === 1 ? matches[0] : null;
}

export function documentWorkspaceTabs(project, openedIds, activeId) {
  return openedIds
    .map((id) => workspaceDocumentById(project, id))
    .filter(Boolean)
    .map((doc) => {
      const title = doc.title || "未命名文档";
      return `<div class="tab${doc.id === activeId ? " selected" : ""}"><button type="button" class="ghost tab-switch" data-open-document-tab="${esc(doc.id)}" ${doc.id === activeId ? 'aria-current="page"' : ""}><span class="method MD">MD</span> <span data-workspace-document-tab-name>${esc(title)}</span></button><button type="button" class="ghost tab-close" data-close-document-tab="${esc(doc.id)}" aria-label="关闭 ${esc(title)}">×</button></div>`;
    })
    .join("");
}

export function documentCounts(content) {
  const text = String(content ?? "");
  return `字数: ${Array.from(text).length}　行数: ${text.split(/\r\n?|\n/).length}`;
}

export function workspaceDocumentHTML(doc, { editing, saving, status }) {
  const title = doc.title || "未命名文档";
  const content = String(doc.content ?? "");
  const preview = `<article class="markdown-content workspace-document-preview" id="workspace-document-preview" aria-label="文档预览" tabindex="0">${renderMarkdown(content)}</article>`;
  return `<section class="workspace-document" aria-label="本地 Markdown 文档">
    <header class="workspace-document-head">
      ${
        editing
          ? `<input id="workspace-document-title" aria-label="文档标题" value="${esc(doc.title)}" autocomplete="off">`
          : `<h1>${esc(title)}</h1>`
      }
      ${status ? `<span class="subtle workspace-document-status">${esc(status)}</span>` : ""}
      <div class="workspace-document-actions"><button type="button" id="workspace-document-settings">文档设置</button><button type="button" id="workspace-document-toggle">${editing ? "预览" : "编辑"}</button><button type="button" id="save" class="primary" title="保存此项目的所有待保存修改" ${saving ? "disabled" : ""}>保存项目</button></div>
    </header>
    ${
      editing
        ? `<div class="workspace-document-editor"><div class="workspace-document-toolbar" role="group" aria-label="文档格式工具">${markdownTools.map(([key, glyph, label]) => `<button type="button" class="ghost" data-workspace-markdown="${key}" aria-label="${esc(label)}" title="${esc(label)}">${esc(glyph)}</button>`).join("")}</div><div class="workspace-document-panes"><textarea id="workspace-document-text" aria-label="Markdown 正文" spellcheck="false">\n${esc(content)}</textarea>${preview}</div><small id="workspace-document-count">${documentCounts(content)}</small></div>`
        : preview
    }
  </section>`;
}

export function prepareWorkspaceDocumentLinks(container) {
  for (const link of container.querySelectorAll("a[href]")) {
    if (link.getAttribute("href").startsWith("#")) continue;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}
