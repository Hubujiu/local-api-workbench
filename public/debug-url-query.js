import { literalQueryEffectiveURL } from "./literal-query-rows.js";

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

export function debugURLQueryBlankState(parsed) {
  const blank = parsed?.rows?.filter((row) => row.value === "") || [];
  if (!blank.length) return null;
  if (blank.every((row) => row.equals)) return "true";
  return blank.some((row) => row.equals) ? "mixed" : "false";
}

export function setDebugURLQueryBlankEquality(raw, equals) {
  const parsed = inspectDebugURLQuery(raw);
  if (!parsed?.rows || typeof equals !== "boolean") return null;
  if (debugURLQueryBlankState(parsed) === null) return raw;
  const next = parsed.rows.map((row, index) =>
    row.value === "" ? row.key + (equals ? "=" : "") : parsed.tokens[index],
  );
  const updated =
    raw.slice(0, parsed.start) + next.join("&") + raw.slice(parsed.end);
  return inspectDebugURLQuery(updated)?.rows ? updated : null;
}

function storedRows(project, request) {
  const saved = project?.literalQueryEditor;
  if (saved?.version !== 1 || saved.projectId !== project.id) return undefined;
  return saved.entries.find((entry) => entry.requestId === request.id);
}

function editorAfterUpdate(project, request, rows, effectiveURL = request.url) {
  const entries = (project.literalQueryEditor?.entries || []).filter(
    (entry) => entry.requestId !== request.id,
  );
  if (rows?.some((row) => !row.enabled))
    entries.push({ requestId: request.id, effectiveURL, rows });
  return { version: 1, projectId: project.id, entries };
}

export function expireLiteralURLQueryRows(project, request) {
  if (!project || !request) return false;
  const entry = storedRows(project, request);
  if (
    !entry ||
    (entry.effectiveURL === request.url &&
      canEditDebugURLQuery(project, request))
  )
    return false;
  project.literalQueryEditor = editorAfterUpdate(project, request);
  return true;
}

export function pruneLiteralURLQueryRows(project) {
  for (const request of project.requests)
    expireLiteralURLQueryRows(project, request);
  const entries = project.literalQueryEditor?.entries;
  if (!entries) return;
  const ids = new Set(project.requests.map(({ id }) => id));
  project.literalQueryEditor.entries = entries.filter((entry) =>
    ids.has(entry.requestId),
  );
}

function projectedRows(project, request) {
  const entry = storedRows(project, request);
  if (
    entry?.effectiveURL === request.url &&
    canEditDebugURLQuery(project, request)
  ) {
    const parsed = inspectDebugURLQuery(
      literalQueryEffectiveURL(request.url, entry.rows, true),
    );
    if (parsed?.rows?.length === entry.rows.length)
      return {
        entry,
        rows: parsed.rows.map((row, i) => ({ ...row, ...entry.rows[i] })),
      };
  }
  const parsed = inspectDebugURLQuery(request.url);
  if (!parsed?.rows) return parsed;
  return {
    rows: parsed.rows.map((row, i) => ({
      ...row,
      token: parsed.tokens[i],
      enabled: true,
    })),
  };
}

const blankEqualityAction = (state) =>
  state === "true" ? "省略 URL 查询空值的等号" : "保留 URL 查询空值的等号";
const notice = "未启用项保留在本地项目，但不进入实际 URL；不影响下方参数表。";

export function debugURLQueryContents(project, request, esc) {
  const parsed = projectedRows(project, request);
  const issue = project?.literalQueryEditorIssue;
  const diagnosis = issue
    ? '<p class="muted" role="status">本地保留的未启用查询项暂不可读；有效 URL 和普通参数仍可编辑。</p>'
    : "";
  if (!parsed) return diagnosis;
  if (parsed.opaque)
    return (
      diagnosis +
      '<p class="muted">此 URL 查询无法安全拆分，请直接编辑请求地址。</p><h3>另加的参数表</h3>'
    );
  const editable = canEditDebugURLQuery(project, request);
  const togglable = editable && !issue;
  const blank = debugURLQueryBlankState({
    rows: parsed.rows.filter((row) => row.enabled),
  });
  const enabled = parsed.rows.filter((row) => row.enabled).length;
  const all = enabled === parsed.rows.length;
  const aggregate = togglable
    ? `<input type="checkbox" class="debug-literal-query-select-all" aria-label="启用全部 URL 查询项" ${all ? "checked" : ""}>`
    : "";
  return `<div class="debug-literal-query-heading"><h3>URL 中的查询</h3>${editable ? `<button class="ghost debug-literal-query-equality" type="button" aria-pressed="${blank ?? "false"}" title="${blankEqualityAction(blank)}"${blank === null ? " hidden" : ""}>URL 空值等号</button>` : ""}</div>${diagnosis}<p class="muted">${editable ? notice : "此 URL 查询仅供查看。原有定义及参数表不会改写。"}</p>
  <table class="pairs-table request-pairs-table debug-literal-query-table" aria-label="URL 中的查询"><thead><tr><th scope="col">${aggregate} 参数名</th><th scope="col">编码值</th></tr></thead><tbody>${parsed.rows
    .map(
      ({ key, value, equals, enabled }, index) =>
        `<tr${enabled ? "" : ' class="debug-literal-query-unchecked"'}><td>${togglable ? `<label><input type="checkbox" data-debug-literal-query-enabled="${index}" aria-label="启用 URL 查询项 ${index + 1}：${esc(key)}" ${enabled ? "checked" : ""}><span>${esc(key)}</span></label>` : esc(key)}</td><td><input type="text" spellcheck="false" autocapitalize="off" autocomplete="off" data-debug-literal-query-value="${index}" aria-label="URL 查询值 ${index + 1}：${esc(key)}" aria-describedby="debug-literal-query-error" value="${esc(value)}"${editable && enabled ? "" : " readonly"}>${!equals ? '<small class="muted">无等号</small>' : ""}</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table><p id="debug-literal-query-error" role="status" hidden></p><h3>另加的参数表</h3>`;
}

export function bindDebugURLQuery(
  region,
  { project, request, urlField, owns, esc, changed, reject },
) {
  let snapshot = request.url;
  let layout = projectedRows(project, request);
  let pending = null;
  let composing = null;
  function refresh() {
    if (!owns()) return;
    snapshot = request.url;
    layout = projectedRows(project, request);
    pending = null;
    composing = null;
    region.innerHTML = debugURLQueryContents(project, request, esc);
    region.hidden = !region.firstElementChild;
    reflectCheckboxes();
  }
  function reflectCheckboxes() {
    const all = region.querySelector(".debug-literal-query-select-all");
    if (!all) return;
    const count = layout.rows.filter((row) => row.enabled).length;
    all.checked = count === layout.rows.length;
    all.indeterminate = count > 0 && count < layout.rows.length;
  }
  const ownsSnapshot = () =>
    snapshot === request.url &&
    urlField.value === snapshot &&
    layout?.entry === projectedRows(project, request)?.entry;
  function publishRows(rows) {
    const next = literalQueryEffectiveURL(snapshot, rows);
    const full = literalQueryEffectiveURL(snapshot, rows, true);
    if (!inspectDebugURLQuery(full)?.rows) return false;
    if (layout.entry || rows.some((row) => !row.enabled)) {
      const editor = editorAfterUpdate(project, request, rows, next);
      if (
        editor.entries.length > 100 ||
        new TextEncoder().encode(JSON.stringify(editor)).length > 1024 * 1024
      ) {
        reject("未启用的 URL 查询项超过项目保留上限，本次未应用。");
        return false;
      }
      project.literalQueryEditor = editor;
    }
    request.url = urlField.value = next;
    snapshot = next;
    layout = projectedRows(project, request);
    changed();
    return true;
  }
  reflectCheckboxes();
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
  function reflectBlankEquality(changedIndex) {
    const control = region.querySelector(".debug-literal-query-equality");
    if (!control) return;
    const parsed = { rows: layout.rows.filter((row) => row.enabled) };
    const state = debugURLQueryBlankState(parsed);
    control.hidden = state === null;
    control.setAttribute("aria-pressed", state ?? "false");
    control.title = blankEqualityAction(state);
    const selector =
      changedIndex === undefined
        ? "[data-debug-literal-query-value]"
        : `[data-debug-literal-query-value="${changedIndex}"]`;
    for (const node of region.querySelectorAll(selector)) {
      const row = layout?.rows?.[Number(node.dataset.debugLiteralQueryValue)];
      if (!row) continue;
      const label = node.parentElement.querySelector("small");
      if (row.equals) label?.remove();
      else if (!label) {
        const marker = node.ownerDocument.createElement("small");
        marker.className = "muted";
        marker.textContent = "无等号";
        node.after(marker);
      }
    }
  }
  function edit(event) {
    const node = event.target;
    if (
      !isEditor(node) ||
      event.isComposing ||
      composing === node ||
      !ownsSnapshot()
    )
      return;
    const index = Number(node.dataset.debugLiteralQueryValue);
    const row = layout?.rows?.[index];
    if (!row?.enabled) return;
    const full = literalQueryEffectiveURL(snapshot, layout.rows, true);
    const next = changeDebugURLQueryValue(full, index, node.value);
    pending = next === null ? node : null;
    report(node, pending !== null);
    if (next === null || next === full) return;
    const token = inspectDebugURLQuery(next).tokens[index];
    const rows = layout.rows.map((item, offset) => ({
      token: offset === index ? token : item.token,
      enabled: item.enabled,
    }));
    if (publishRows(rows)) reflectBlankEquality(index);
    else {
      pending = node;
      report(node, true);
    }
  }
  function cancel(node) {
    if (!isEditor(node) || pending !== node) return;
    const row = layout?.rows?.[Number(node.dataset.debugLiteralQueryValue)];
    if (row) node.value = row.value;
    report(node, false);
    pending = null;
  }
  function ownsBlankControl(node) {
    return (
      owns() &&
      node.isConnected &&
      !node.hidden &&
      node.matches(".debug-literal-query-equality") &&
      node.closest(".debug-literal-query-origin") === region &&
      canEditDebugURLQuery(project, request)
    );
  }
  region.addEventListener("click", ({ target }) => {
    const control = target.closest(".debug-literal-query-equality");
    if (
      !control ||
      !ownsBlankControl(control) ||
      pending ||
      composing ||
      !ownsSnapshot()
    )
      return;
    const state = debugURLQueryBlankState({
      rows: layout.rows.filter((row) => row.enabled),
    });
    if (state === null) return;
    const rows = layout.rows.map((row) => ({
      token:
        row.enabled && row.value === ""
          ? row.key + (state === "true" ? "" : "=")
          : row.token,
      enabled: row.enabled,
    }));
    if (publishRows(rows)) reflectBlankEquality();
  });
  const ownsCheckbox = (node) =>
    owns() &&
    !project.literalQueryEditorIssue &&
    node.isConnected &&
    node.matches(
      ".debug-literal-query-select-all, [data-debug-literal-query-enabled]",
    ) &&
    node.closest(".debug-literal-query-origin") === region &&
    canEditDebugURLQuery(project, request);
  region.addEventListener("change", ({ target }) => {
    if (!ownsCheckbox(target)) return;
    const selector = target.matches(".debug-literal-query-select-all")
      ? ".debug-literal-query-select-all"
      : `[data-debug-literal-query-enabled="${Number(target.dataset.debugLiteralQueryEnabled)}"]`;
    if (!ownsSnapshot() || pending || composing) {
      refresh();
      return;
    }
    const index = target.matches(".debug-literal-query-select-all")
      ? -1
      : Number(target.dataset.debugLiteralQueryEnabled);
    const rows = layout.rows.map((row, offset) => ({
      token: row.token,
      enabled: index === -1 || offset === index ? target.checked : row.enabled,
    }));
    if (
      rows.some((row, i) => row.enabled !== layout.rows[i].enabled) &&
      publishRows(rows)
    ) {
      refresh();
      region.querySelector(selector)?.focus({ preventScroll: true });
    } else {
      if (index >= 0) target.checked = layout.rows[index].enabled;
      reflectCheckboxes();
    }
  });
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
    const control =
      ownsBlankControl(event.target) || ownsCheckbox(event.target);
    if (!control && !isProjectedField(event.target)) return;
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
    if (control) return;
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
