const types = ["string", "number", "integer", "boolean"];
export const isDesignQueryScalarType = (type) => types.includes(type);
const annotations = new Set([
  "type",
  "title",
  "description",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const stringConstraints = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "contentEncoding",
  "contentMediaType",
]);
const numberConstraints = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);
const literals = new Set(["default", "example", "const", "enum", "examples"]);
const serialization = [
  "querySerialization",
  "queryObjectSerialization",
  "reservedQuerySerialization",
];
const format = {
  string: new Set([
    "date",
    "date-time",
    "time",
    "uri",
    "email",
    "uuid",
    "byte",
    "binary",
    "password",
    "hostname",
    "ipv4",
    "ipv6",
  ]),
  number: new Set(["float", "double"]),
  integer: new Set(["int32", "int64"]),
};
const changeError = () =>
  Error("快速类型切换无法保留现有约束、格式或示例，请使用「定义」编辑。");
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function designQueryMetadata(row) {
  if (typeof row?.key !== "string" || !row.key.trim()) return null;
  const schema = row.schema;
  const type = schema === undefined ? "string" : object(schema) && schema.type;
  return {
    required: row.required === true,
    type:
      types.includes(type) &&
      !serialization.some((key) => Object.hasOwn(row, key)) &&
      (!object(schema) ||
        Object.keys(schema).every(
          (key) =>
            annotations.has(key) ||
            stringConstraints.has(key) ||
            numberConstraints.has(key) ||
            literals.has(key) ||
            key === "format",
        ))
        ? type
        : null,
  };
}

export function prepareDesignQueryType(row, type) {
  const info = designQueryMetadata(row);
  if (!info?.type || !types.includes(type)) throw changeError();
  if (info.type === type) return null;
  const schema = row.schema ?? { type: "string" };
  const matches = (v) =>
    type === "integer"
      ? Number.isInteger(v)
      : type === "number"
        ? Number.isFinite(v)
        : typeof v === type;
  for (const key of Object.keys(schema)) {
    if (annotations.has(key)) continue;
    if (key === "format" && format[type]?.has(schema.format)) continue;
    if (type === "string" && stringConstraints.has(key)) continue;
    if (["number", "integer"].includes(type) && numberConstraints.has(key))
      continue;
    if (literals.has(key)) {
      const value = schema[key];
      if (key === "examples" || key === "enum") {
        if (Array.isArray(value) && value.every(matches)) continue;
      } else if (matches(value)) continue;
    }
    throw changeError();
  }
  return { ...schema, type };
}

export function designQueryMetadataHTML(row, index, esc) {
  const info = designQueryMetadata(row);
  if (!info) return "";
  const label = esc(row.key);
  return `${info.type ? `<button type="button" class="ghost design-query-type" data-design-query-type="${index}" data-design-query-current="${info.type}" data-query-type-color="${info.type}" aria-label="更改 ${label} 的类型：${info.type}" aria-haspopup="menu" aria-expanded="false" aria-controls="design-query-type-menu">${info.type}</button>` : ""}
    <button type="button" class="ghost design-query-required" data-design-query-required="${index}" aria-pressed="${info.required}" title="必填" aria-label="${label} 必填"><span aria-hidden="true">*</span></button>`;
}

export function designQueryTypeMenuHTML() {
  return `<div id="design-query-type-menu" popover role="menu" aria-label="Query 标量类型">${types
    .map(
      (type) =>
        `<button type="button" data-design-query-option="${type}" data-query-type-color="${type}" role="menuitemradio" tabindex="-1" aria-checked="false">${type}</button>`,
    )
    .join("")}</div>`;
}

export function bindDesignQueryTypeMenu(root, { capture, update, notify }) {
  const menu = root?.querySelector("#design-query-type-menu");
  if (!menu) return;
  const options = [...menu.querySelectorAll("[data-design-query-option]")];
  let opener, token;
  const open = () => menu.matches(":popover-open");
  const clear = () => {
    opener?.setAttribute("aria-expanded", "false");
    opener = token = undefined;
  };
  const close = (focus) => {
    const previous = opener;
    if (open()) menu.hidePopover();
    clear();
    if (focus && previous?.isConnected) previous.focus({ preventScroll: true });
  };
  menu.addEventListener("toggle", () => {
    if (!open()) clear();
  });
  const show = (button) => {
    if (!root.isConnected || !button.isConnected) return;
    if (open() && opener === button) return close(true);
    close(false);
    try {
      token = capture(button);
    } catch (error) {
      notify(error.message);
      return;
    }
    opener = button;
    button.setAttribute("aria-expanded", "true");
    const selected = button.dataset.designQueryCurrent;
    for (const option of options)
      option.setAttribute(
        "aria-checked",
        String(option.dataset.designQueryOption === selected),
      );
    menu.showPopover();
    const bounds = button.getBoundingClientRect();
    const x = Math.min(innerWidth - menu.offsetWidth - 8, bounds.left + 6);
    const y =
      bounds.bottom + 6 + menu.offsetHeight <= innerHeight - 8
        ? bounds.bottom + 6
        : Math.min(
            bounds.top - menu.offsetHeight - 6,
            innerHeight - menu.offsetHeight - 8,
          );
    menu.style.setProperty("--design-query-menu-x", Math.max(8, x) + "px");
    menu.style.setProperty("--design-query-menu-y", Math.max(8, y) + "px");
    options
      .find((cue) => cue.dataset.designQueryOption === selected)
      ?.focus({ preventScroll: true });
  };
  for (const trigger of root.querySelectorAll(
    "[data-design-query-type],[data-design-query-draft-type]",
  )) {
    trigger.addEventListener("click", () => show(trigger));
    trigger.addEventListener("keydown", (event) => {
      if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      show(trigger);
    });
  }
  menu.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      ["s", "Enter"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") close(true);
    else {
      const index = options.indexOf(event.target);
      const next = {
        Home: 0,
        End: options.length - 1,
        ArrowUp: (index + options.length - 1) % options.length,
        ArrowDown: (index + 1) % options.length,
      }[event.key];
      if (!Number.isInteger(next)) return;
      event.preventDefault();
      options[next]?.focus({ preventScroll: true });
    }
  });
  menu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-design-query-option]");
    if (!item || !open() || !opener?.isConnected) return;
    const previous = token;
    close(true);
    try {
      update(previous, item.dataset.designQueryOption);
    } catch (error) {
      notify(error.message);
    }
  });
}
