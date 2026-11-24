const fileLimit = 6 * 1024 * 1024;
const metadataNotice =
  "此正文含有导入或动态模板，不能直接替换或切换 Binary。请保留原定义，或新建不含模板的接口。";

function protectedBody(request) {
  return (
    request.postmanRawBody !== undefined ||
    request.graphqlVariableTemplate !== undefined ||
    Object.keys(request.bodyDynamic ?? {}).length > 0
  );
}

export function prepareBinaryBodyChange(request, nextType) {
  const previousType = request.bodyType;
  if (
    nextType === previousType ||
    (nextType !== "binary" && previousType !== "binary")
  )
    return null;
  if (protectedBody(request)) throw Error(metadataNotice);
  return { clear: Boolean(request.body), nextType };
}

export function binaryBodyHTML(request, { debug, icon }) {
  const locked = protectedBody(request);
  return `<section class="binary-body-editor${debug ? " debug-binary-body" : ""}" aria-label="二进制请求体">${
    debug && !locked
      ? `<label class="binary-body-upload"><span aria-hidden="true">${icon("upload-body")}</span><span>上传文件</span><input type="file" aria-label="上传文件" aria-describedby="binary-body-local-note binary-body-note"></label><span id="binary-body-local-note" hidden>读取本地文件，只更新当前接口草稿，不会自动保存或发送。</span>`
      : ""
  }<div class="binary-body-controls"><p id="binary-body-note"${locked ? "" : ' role="status"'}>${
    locked ? metadataNotice : request.body ? "已载入二进制请求体" : ""
  }</p><button type="button" class="ghost" id="binary-body-disclosure" aria-expanded="false" aria-controls="binary-body-manual">${locked ? "查看 Base64" : "手动编辑 Base64"}</button></div><div id="binary-body-manual" hidden></div></section>`;
}

export async function readBinaryBodyFile(file, owns) {
  if (!file || !owns()) return;
  if (file.size === 0) throw Error("请选择非空文件");
  if (file.size > fileLimit) throw Error("文件不能超过 6 MiB");
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    if (!owns()) return;
    throw Error("无法读取选择的文件，请重新选择");
  }
  if (!owns()) return;
  if (bytes.length === 0) throw Error("请选择非空文件");
  if (bytes.length > fileLimit) throw Error("文件不能超过 6 MiB");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function bindBinaryBodyEditor(
  root,
  { request, owns, confirm, mark, toast },
) {
  const input = root.querySelector("input[type=file]");
  const toggle = root.querySelector("#binary-body-disclosure");
  const panel = root.querySelector("#binary-body-manual");
  const note = root.querySelector("#binary-body-note");
  const current = () =>
    root.isConnected && owns() && request.bodyType === "binary";
  const locked = protectedBody(request);
  let revision = 0;
  let editor = null;
  const update = (body) => {
    if (!current() || locked || body === request.body) return;
    request.body = body;
    note.textContent = body ? "已载入二进制请求体" : "";
    mark();
  };
  toggle.addEventListener("click", () => {
    if (!current()) return;
    if (editor) {
      editor = null;
      panel.replaceChildren();
      panel.hidden = true;
    } else {
      const field = document.createElement("textarea");
      editor = field;
      field.setAttribute("aria-label", "请求体 Base64");
      field.spellcheck = false;
      field.readOnly = locked;
      field.value = request.body;
      field.addEventListener("input", () => {
        if (editor !== field || !current() || locked) return;
        revision++;
        update(field.value);
      });
      panel.replaceChildren(field);
      panel.hidden = false;
      field.focus();
    }
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    toggle.textContent = panel.hidden
      ? locked
        ? "查看 Base64"
        : "手动编辑 Base64"
      : "收起 Base64";
  });
  if (!input) return;
  const invalidate = () => {
    revision++;
  };
  input.addEventListener("click", invalidate);
  input.addEventListener("cancel", invalidate);
  input.addEventListener("change", async () => {
    const selected = input.files[0];
    // Detach the FileList immediately; a new chooser action owns a new revision.
    input.value = "";
    const token = ++revision;
    const previous = request.body;
    const ownsSelection = () =>
      current() &&
      input.isConnected &&
      revision === token &&
      request.body === previous;
    try {
      if (!selected || !ownsSelection()) return;
      if (previous && !confirm("替换文件会清除当前二进制请求体。确定继续？"))
        return;
      const body = await readBinaryBodyFile(selected, ownsSelection);
      if (body === undefined || !ownsSelection()) return;
      update(body);
      if (editor) editor.value = body;
    } catch (error) {
      if (ownsSelection()) toast(error.message);
    }
  });
}
