const unsafeRaw = /[^\x21-\x7e]|[\\{}<>"`']|%(?![\da-f]{2})/i;
const incompatible = [
  "nativeInheritance",
  "nativeTasks",
  "nativeMock",
  "nativeMockRoute",
  "importedNativeTaskSource",
  "importedScriptTasks",
  "postmanCollectionId",
  "postmanRawBody",
  "graphqlEditorVersion",
  "graphqlVariableTemplate",
  "scriptURLRuntime",
  "openapiExampleBindingsVersion",
  "openapiExampleSources",
];

export function inspectDebugURLQuery(raw) {
  if (typeof raw !== "string") return null;
  const fragmentAt = raw.indexOf("#");
  const head = fragmentAt < 0 ? raw : raw.slice(0, fragmentAt);
  const queryAt = head.indexOf("?");
  if (queryAt < 0) return null;
  const suffix = head.slice(queryAt + 1);
  if (
    !/^https?:\/\/[^/?#@]+(?:[/?]|$)/i.test(head) ||
    head.length > 65536 ||
    unsafeRaw.test(head) ||
    /[{}]/.test(raw) ||
    !suffix
  )
    return { opaque: true };
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search !== "?" + suffix)
      return { opaque: true };
  } catch {
    return { opaque: true };
  }
  const tokens = suffix.split("&");
  if (
    tokens.length > 1000 ||
    tokens.some((token) => !token || token.startsWith("="))
  )
    return { opaque: true };
  return {
    start: queryAt + 1,
    end: head.length,
    rows: tokens.map((token) => {
      const eq = token.indexOf("=");
      return eq < 0
        ? { key: token, value: "", equals: false }
        : { key: token.slice(0, eq), value: token.slice(eq + 1), equals: true };
    }),
    tokens,
  };
}

export function canEditDebugURLQuery(project, request) {
  return Boolean(
    request?.query &&
      !project?.settings?.nativeInheritance &&
      !request.sourceOperationId &&
      !request.importNotes?.length &&
      !Object.keys(request.openapiOperation || {}).length &&
      !request.serviceId &&
      !project?.settings?.folderServices?.[request.folder] &&
      !request.serviceSnapshot &&
      !request.parametersSnapshot &&
      request.scriptURLMode !== "sdk" &&
      !request.query.some((row) =>
        [
          "querySerialization",
          "queryObjectSerialization",
          "reservedQuerySerialization",
        ].some((key) => Object.hasOwn(row || {}, key)),
      ) &&
      incompatible.every((key) => request[key] === undefined),
  );
}

export function changeDebugURLQueryValue(raw, index, value) {
  const parsed = inspectDebugURLQuery(raw);
  const row = parsed?.rows?.[index];
  if (!Number.isInteger(index) || !row || typeof value !== "string")
    return null;
  if (value === row.value) return raw;
  if (unsafeRaw.test(value) || /[&#]/.test(value) || value.length > 65536)
    return null;
  const next = parsed.tokens.slice();
  next[index] = row.key + "=" + value;
  const updated =
    raw.slice(0, parsed.start) + next.join("&") + raw.slice(parsed.end);
  return inspectDebugURLQuery(updated)?.rows ? updated : null;
}

const notice =
  "仅编辑 URL 中选中一项的编码文本；下方参数表及其等号设置不受影响。";

export function debugURLQueryContents(project, request, esc) {
  const parsed = inspectDebugURLQuery(request.url);
  if (!parsed) return "";
  if (parsed.opaque)
    return '<p class="muted">此 URL 查询无法安全拆分，请直接编辑请求地址。</p><h3>另加的参数表</h3>';
  const editable = canEditDebugURLQuery(project, request);
  return `<h3>URL 中的查询</h3><p class="muted">${editable ? notice : "此 URL 查询仅供查看。原有定义及参数表不会改写。"}</p>
  <table class="pairs-table request-pairs-table debug-literal-query-table" aria-label="URL 中的查询"><thead><tr><th scope="col">参数名</th><th scope="col">编码值</th></tr></thead><tbody>${parsed.rows
    .map(
      ({ key, value, equals }, index) =>
        `<tr><td>${esc(key)}</td><td><input type="text" spellcheck="false" autocapitalize="off" autocomplete="off" data-debug-literal-query-value="${index}" aria-label="URL 查询值 ${index + 1}：${esc(key)}" aria-describedby="debug-literal-query-error" value="${esc(value)}"${editable ? "" : " readonly"}>${!equals ? '<small class="muted">无等号</small>' : ""}</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table><p id="debug-literal-query-error" role="status" hidden></p><h3>另加的参数表</h3>`;
}

export function bindDebugURLQuery(
  region,
  { project, request, urlField, owns, esc, changed },
) {
  let snapshot = request.url;
  let pending = null;
  let composing = null;
  function refresh() {
    if (!owns()) return;
    snapshot = request.url;
    pending = null;
    composing = null;
    region.innerHTML = debugURLQueryContents(project, request, esc);
    region.hidden = !region.firstElementChild;
  }
  function isProjectedField(node) {
    return (
      owns() &&
      node.closest(".debug-literal-query-origin") === region &&
      node.isConnected &&
      node.matches("[data-debug-literal-query-value]")
    );
  }
  function isEditor(node) {
    return (
      isProjectedField(node) &&
      !node.readOnly &&
      canEditDebugURLQuery(project, request)
    );
  }
  function report(node, invalid) {
    node.setAttribute("aria-invalid", String(invalid));
    const error = region.querySelector("#debug-literal-query-error");
    error.hidden = !invalid;
    error.textContent = invalid
      ? "需输入有效的 URL 编码值，例如 %2B；未应用此输入。"
      : "";
  }
  function edit(event) {
    const node = event.target;
    if (
      !isEditor(node) ||
      event.isComposing ||
      composing === node ||
      snapshot !== request.url ||
      urlField.value !== snapshot
    )
      return;
    const index = Number(node.dataset.debugLiteralQueryValue);
    const next = changeDebugURLQueryValue(snapshot, index, node.value);
    pending = next === null ? node : null;
    report(node, pending !== null);
    if (next === null || next === snapshot) return;
    snapshot = request.url = urlField.value = next;
    const equals = inspectDebugURLQuery(next).rows[index].equals;
    if (equals) node.parentElement.querySelector("small")?.remove();
    changed();
  }
  function cancel(node) {
    if (!isEditor(node) || pending !== node) return;
    const row =
      inspectDebugURLQuery(snapshot)?.rows?.[
        Number(node.dataset.debugLiteralQueryValue)
      ];
    if (row) node.value = row.value;
    report(node, false);
    pending = null;
  }
  region.addEventListener("input", edit);
  region.addEventListener("compositionstart", ({ target }) => {
    if (isEditor(target)) composing = target;
  });
  region.addEventListener("compositionend", (event) => {
    if (composing === event.target) composing = null;
    edit(event);
  });
  region.addEventListener("focusout", (event) => cancel(event.target));
  region.addEventListener("keydown", (event) => {
    if (!isProjectedField(event.target)) return;
    if (
      (event.ctrlKey || event.metaKey) &&
      (event.key === "Enter" ||
        (event.key.toLowerCase() === "s" &&
          (event.isComposing ||
            event.target === pending ||
            event.target === composing)))
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      !isEditor(event.target) ||
      event.isComposing ||
      event.target === composing
    )
      return;
    if (event.key === "Escape" && event.target === pending) {
      event.preventDefault();
      event.stopPropagation();
      cancel(event.target);
    }
    if (event.key === "Enter" && !(event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      edit(event);
    }
  });
  return refresh;
}
