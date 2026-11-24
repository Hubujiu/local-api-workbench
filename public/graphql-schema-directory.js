export const LOCAL_SCHEMA_LIMIT = 2 * 1024 * 1024;
const maxTypes = 2048;
const typeKinds = new Set([
  "SCALAR",
  "OBJECT",
  "INTERFACE",
  "UNION",
  "ENUM",
  "INPUT_OBJECT",
]);
const rootKinds = ["query", "mutation", "subscription"];
const namePattern = /^[_A-Za-z][_0-9A-Za-z]{0,127}$/;
const invalid = () =>
  Error("文件不是受支持的 GraphQL Introspection JSON 类型目录。");
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

export function readLocalGraphQLSchema(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.length > LOCAL_SCHEMA_LIMIT
  )
    throw Error("请选择不超过 2 MiB 的 UTF-8 Schema JSON 文件。");
  let payload;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw invalid();
  }
  if (
    !object(payload) ||
    (Object.hasOwn(payload, "errors") &&
      (!Array.isArray(payload.errors) || payload.errors.length !== 0)) ||
    !object(payload.data) ||
    !Object.hasOwn(payload.data, "__schema")
  )
    throw invalid();
  const schema = payload.data.__schema;
  if (
    !object(schema) ||
    !Array.isArray(schema.types) ||
    schema.types.length === 0 ||
    schema.types.length > maxTypes
  )
    throw invalid();
  const entries = new Map();
  for (const type of schema.types) {
    if (
      !object(type) ||
      typeof type.name !== "string" ||
      !namePattern.test(type.name) ||
      !typeKinds.has(type.kind) ||
      entries.has(type.name)
    )
      throw invalid();
    entries.set(type.name, Object.freeze({ name: type.name, kind: type.kind }));
  }
  const roots = [];
  for (const root of rootKinds) {
    const value = schema[root + "Type"];
    if (root !== "query" && value == null) continue;
    if (
      !object(value) ||
      typeof value.name !== "string" ||
      entries.get(value.name)?.kind !== "OBJECT"
    )
      throw invalid();
    roots.push(Object.freeze({ role: root, name: value.name }));
  }
  return Object.freeze({
    roots: Object.freeze(roots),
    types: Object.freeze(
      [...entries.values()].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      ),
    ),
  });
}

export function createGraphQLSchemaDirectory() {
  const directory = new WeakMap();
  return {
    get: (request) => directory.get(request),
    install: (request, summary) => directory.set(request, summary),
    clear: (request) => directory.delete(request),
  };
}

export function graphQLSchemaDirectoryHTML() {
  return `<aside class="graphql-schema-directory" aria-label="GraphQL Schema 类型目录">
    <div class="graphql-schema-title"><h3>GraphQL Schema</h3><button type="button" id="graphql-schema-clear" class="ghost" hidden>清除</button></div>
    <div class="graphql-schema-content">
      <p id="graphql-schema-empty">暂无数据</p>
      <div id="graphql-schema-results" hidden>
        <ul id="graphql-schema-roots" aria-label="操作根类型"></ul>
        <label class="graphql-schema-filter"><span>筛选类型</span><input id="graphql-schema-filter" type="search" maxlength="128" autocomplete="off" placeholder="名称或类别"></label>
        <p id="graphql-schema-count" role="status"></p>
        <ul id="graphql-schema-types" aria-label="Schema 类型"></ul>
      </div>
      <button type="button" id="graphql-schema-open">打开本地 Schema JSON</button>
      <input id="graphql-schema-file" type="file" accept=".json,application/json" hidden>
      <p class="graphql-schema-note">仅在当前打开的请求中查看类型目录，不保存文件、不访问接口 URL。</p>
      <p class="graphql-schema-message" aria-live="polite"></p>
    </div>
  </aside>`;
}

export function bindGraphQLSchemaDirectory(root, { request, directory, owns }) {
  const rootList = root.querySelector("#graphql-schema-roots");
  const typeList = root.querySelector("#graphql-schema-types");
  const count = root.querySelector("#graphql-schema-count");
  const filter = root.querySelector("#graphql-schema-filter");
  const file = root.querySelector("#graphql-schema-file");
  const open = root.querySelector("#graphql-schema-open");
  const clear = root.querySelector("#graphql-schema-clear");
  const empty = root.querySelector("#graphql-schema-empty");
  const results = root.querySelector("#graphql-schema-results");
  const message = root.querySelector(".graphql-schema-message");
  const active = () => root.isConnected && owns();
  let sequence = 0;

  const listItem = (name, kind) => {
    const item = root.ownerDocument.createElement("li");
    const label = root.ownerDocument.createElement("strong");
    const badge = root.ownerDocument.createElement("small");
    label.textContent = name;
    badge.textContent = kind;
    item.append(label, badge);
    return item;
  };
  const showTypes = (summary) => {
    const needle = filter.value.trim().toLowerCase();
    const matches = summary.types.filter(({ name, kind }) =>
      [name, kind].some((text) => text.toLowerCase().includes(needle)),
    );
    typeList.replaceChildren(
      ...matches.map(({ name, kind }) => listItem(name, kind)),
    );
    count.textContent = matches.length
      ? `${matches.length} / ${summary.types.length} 个类型`
      : "没有匹配的类型";
  };
  const show = () => {
    const summary = directory.get(request);
    empty.hidden = Boolean(summary);
    clear.hidden = results.hidden = !summary;
    if (summary) {
      rootList.replaceChildren(
        ...summary.roots.map(({ role, name }) => listItem(name, role)),
      );
      showTypes(summary);
    } else {
      rootList.replaceChildren();
      typeList.replaceChildren();
      count.textContent = "";
    }
  };
  show();
  filter.addEventListener("input", () => {
    const summary = directory.get(request);
    if (active() && summary) showTypes(summary);
  });
  const invalidate = () => {
    sequence++;
  };
  open.addEventListener("click", () => {
    if (!active()) return;
    invalidate();
    file.value = "";
    file.click();
  });
  file.addEventListener("cancel", invalidate);
  file.addEventListener("change", async () => {
    const selected = file.files[0];
    file.value = "";
    const selection = ++sequence;
    const current = () => selection === sequence && active();
    if (!selected || !current()) return;
    message.textContent = "";
    try {
      if (!selected.size || selected.size > LOCAL_SCHEMA_LIMIT)
        throw Error("请选择不超过 2 MiB 的 UTF-8 Schema JSON 文件。");
      const bytes = new Uint8Array(await selected.arrayBuffer());
      if (!current()) return;
      const summary = readLocalGraphQLSchema(bytes);
      if (!current()) return;
      directory.install(request, summary);
      filter.value = "";
      show();
      message.textContent = "已载入本地类型目录。";
    } catch (error) {
      if (current())
        message.textContent =
          error?.message === "请选择不超过 2 MiB 的 UTF-8 Schema JSON 文件。"
            ? error.message
            : "无法读取此 Schema JSON。需提供 data.__schema 类型目录；已载入的目录不变。";
    }
  });
  clear.addEventListener("click", () => {
    if (!active()) return;
    invalidate();
    directory.clear(request);
    filter.value = "";
    message.textContent = "";
    show();
    open.focus({ preventScroll: true });
  });
}
