import { icon } from "./icons.js";

export function projectCreateForm() {
  return `<section class="project-create-form">
    <label for="new-name">项目名称</label>
    <input id="new-name" maxlength="100" placeholder="请输入项目名称">
    <label for="new-directory">存储位置</label>
    <div class="project-create-directory"><input id="new-directory" aria-describedby="new-directory-hint" placeholder="留空使用默认目录"><button id="pick-directory" type="button">${icon("folder")}选择位置</button></div>
    <small id="new-directory-hint" hidden>使用默认目录，或选择本机目录。手动填写时请使用绝对路径。</small>
    <label for="new-description">项目描述</label>
    <textarea id="new-description" maxlength="2000" placeholder="请输入项目描述"></textarea>
    <div class="project-create-settlement">
      <p id="project-create-status" tabindex="-1" role="status" hidden></p>
      <button id="project-create-review" type="button" hidden>重新读取项目列表</button>
      <button id="project-create-reset" type="button" hidden>已核对，开始新的创建</button>
    </div>
  </section>`;
}
