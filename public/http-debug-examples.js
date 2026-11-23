import { validateMockResponse } from "./response-example.js";
import { isJsonResponseType, isResponseMediaType } from "./response-media.js";

const encoder = new TextEncoder();
const bodyLimit = 8 * 1024 * 1024;
const editableLimit = 256 * 1024;
const presets = [
  { key: "success", name: "成功", status: 200 },
  { key: "failure", name: "失败", status: 400 },
];

export function ordinaryExampleDraft(request) {
  return Boolean(
    request &&
      !(
        typeof request.sourceOperationId === "string" &&
        /^apipost(?:-sample)?:/i.test(request.sourceOperationId)
      ) &&
      [
        "graphqlEditorVersion",
        "graphqlVariableTemplate",
        "openapiExampleBindingsVersion",
        "openapiExampleSources",
        "nativeInheritance",
        "nativeMock",
        "nativeMockRoute",
        "nativeTasks",
        "importedNativeTaskSource",
        "importedScriptTasks",
        "postmanCollectionId",
      ].every((key) => request[key] === undefined),
  );
}

export function debugExampleChoices(request, selected) {
  const actual = request.examples.map((row, index) => ({
    key: String(index),
    row,
    name: row?.name || String(row?.status ?? "") || "未命名",
  }));
  const choices = [
    ...actual,
    ...(ordinaryExampleDraft(request)
      ? presets.filter(
          ({ status, key }) =>
            selected === key ||
            !actual.some(
              ({ row }) =>
                Math.floor(row?.status / 100) === Math.floor(status / 100),
            ),
        )
      : []),
  ];
  return {
    choices,
    current:
      choices.find((choice) =>
        typeof selected === "string"
          ? choice.key === selected && !choice.row
          : choice.row === selected && selected !== undefined,
      ) || choices[0],
  };
}

function editableMedia(row) {
  const contentTypes = Object.entries(row?.headers || {}).filter(
    ([key]) => key.toLowerCase() === "content-type",
  );
  if (contentTypes.length > 1) return "";
  const type = contentTypes.length ? contentTypes[0][1] : "application/json";
  if (isJsonResponseType(type)) return "json";
  if (
    isResponseMediaType(type) &&
    type.split(";")[0].trim().toLowerCase() === "text/plain"
  )
    return "text";
  return "";
}

export function editableDebugExample(request, row) {
  if (
    !ordinaryExampleDraft(request) ||
    !row ||
    Object.keys(row).some(
      (key) => !["name", "status", "body", "headers", "delayMs"].includes(key),
    ) ||
    typeof row.body !== "string" ||
    encoder.encode(row.body).length > editableLimit ||
    !editableMedia(row)
  )
    return false;
  try {
    validateMockResponse(row, { allowInformational: true });
    return true;
  } catch {
    return false;
  }
}

function budget(request, value, existing) {
  if (request.examples.length + Number(!existing) > 1000)
    throw Error("每个接口响应示例最多1000项");
  let bytes = encoder.encode(value.body).length;
  for (const row of request.examples)
    if (row !== existing && typeof row?.body === "string")
      bytes += encoder.encode(row.body).length;
  if (bytes > bodyLimit) throw Error("每个接口响应示例正文合计最多8MiB");
}

export function validateDebugExampleBody(request, row, body) {
  if (encoder.encode(body).length > editableLimit)
    throw Error("行内编辑正文最多256KiB；请在 Mock 页编辑更大的示例");
  const next = { ...row, body };
  validateMockResponse(next, { allowInformational: true });
  if (editableMedia(row) === "json")
    try {
      JSON.parse(body);
    } catch {
      throw Error("JSON 响应示例正文无效");
    }
  budget(request, next, row);
}

export function prepareDebugExampleMetadata(request, row, name, rawStatus) {
  if (
    !ordinaryExampleDraft(request) ||
    (row && !editableDebugExample(request, row))
  )
    throw Error("此示例仅供查看；请使用对应的响应定义或 Mock 编辑器");
  if (typeof name !== "string" || !name.trim() || name.length > 8192)
    throw Error("请输入非空示例名称（最多8192字符）");
  const status = /^\d{3}$/u.test(rawStatus) ? Number(rawStatus) : NaN;
  const next = row
    ? { ...row, name, status }
    : { name, status, body: "", headers: { "content-type": "text/plain" } };
  validateMockResponse(next, { allowInformational: true });
  budget(request, next, row);
  return next;
}

export function createDebugExampleDrafts() {
  const invalid = new WeakMap();
  return {
    read: (row) => invalid.get(row),
    assertReplaceable(row) {
      if (invalid.has(row))
        throw Error("请返回调试的响应示例，修正或撤回该示例的无效正文后再编辑");
    },
    clear: (row) => invalid.delete(row),
    pending: (requests) =>
      requests.some((request) =>
        request.examples?.some((row) => invalid.has(row)),
      ),
    edit(request, row, body) {
      try {
        validateDebugExampleBody(request, row, body);
        row.body = body;
        invalid.delete(row);
      } catch (error) {
        invalid.set(row, { body, message: error.message });
      }
    },
  };
}

export function debugExamplesHTML(request, selected, drafts, esc) {
  const { choices, current } = debugExampleChoices(request, selected);
  const canAuthor = ordinaryExampleDraft(request);
  const row = current?.row,
    editable = editableDebugExample(request, row);
  const invalid = drafts.read(row);
  const format = editable
    ? editableMedia(row) === "json"
      ? "JSON"
      : "纯文本"
    : "";
  const status = row?.status;
  return `<section class="http-debug-examples" aria-label="响应示例编辑区">
    <div class="http-debug-example-tools"><div class="http-debug-example-choices" role="group" aria-label="示例列表">${choices.map(({ key, name, row: stored }) => `<button type="button" data-debug-example-choice="${key}" class="ghost" aria-pressed="${key === current?.key}"${stored ? "" : ' title="未保存的示例预设"'}>${esc(name)}</button>`).join("")}</div>
    ${canAuthor && current && (!row || editable) ? '<button id="debug-example-edit" type="button" class="ghost" aria-haspopup="dialog" aria-expanded="false" aria-controls="debug-example-settings">编辑</button>' : ""}
    ${canAuthor ? '<button id="debug-example-add" type="button" class="ghost" aria-haspopup="dialog" aria-expanded="false" aria-controls="debug-example-settings"><span aria-hidden="true">＋</span> 新建期望</button>' : ""}
    ${format ? `<small class="http-debug-example-format">${format} · ${esc(status)}</small>` : ""}</div>
    <textarea id="debug-example-body" aria-label="响应示例正文" spellcheck="false" aria-invalid="${Boolean(invalid)}" aria-describedby="debug-example-error"${editable ? "" : " readonly"} placeholder="${row ? "" : canAuthor ? "预设未保存。请选择编辑或新建期望。" : "没有可显示的示例。"}">\n${esc(invalid?.body ?? (typeof row?.body === "string" ? row.body : ""))}</textarea>
    <p id="debug-example-error" role="status" ${invalid ? "" : "hidden"}>${esc(invalid?.message ?? "")}</p>
    ${row && !editable ? '<p class="muted">此示例只读。请在原响应定义或 Mock 页编辑，以保留来源和媒体信息。</p>' : ""}
    ${canAuthor ? '<form id="debug-example-settings" popover="auto" role="dialog" aria-label="响应示例设置"><label>名称<input id="debug-example-name" maxlength="8192" required></label><label>状态码<input id="debug-example-status" inputmode="numeric" maxlength="3" required></label><div><button id="debug-example-cancel" type="button" class="ghost">取消</button><button type="submit" class="primary">确定</button></div></form>' : ""}
  </section>`;
}
