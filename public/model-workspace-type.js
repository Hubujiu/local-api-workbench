import { editSchemaNode, schemaRows, schemaTypes } from "./schema-editor.js";

const orderedTypes = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
];
const supported = new Set(schemaTypes);
const annotations = new Set([
  "type",
  "title",
  "description",
  "$comment",
  "$id",
  "$schema",
  "$anchor",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const literals = new Set(["default", "example", "examples", "const", "enum"]);
const stringKeys = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
]);
const numberKeys = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);
const objectKeys = new Set([
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedProperties",
]);
const arrayKeys = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "unevaluatedItems",
]);
const complexKeys = [
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
];

export function isModelTypeProperty(row) {
  const node = row?.schema;
  return Boolean(
    row?.path.at(-2) === "properties" &&
      node &&
      typeof node === "object" &&
      !Array.isArray(node) &&
      supported.has(node.type) &&
      !complexKeys.some((key) => Object.hasOwn(node, key)),
  );
}

function matchesLiteral(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

export function changeWorkspaceModelFieldType(schema, offset, target) {
  const row = Number.isSafeInteger(offset) && schemaRows(schema)[offset + 1];
  if (!supported.has(target) || !isModelTypeProperty(row))
    throw Error("当前字段不能在这里更改类型，请使用 Raw 编辑");
  const node = row.schema;
  if (node.type === target) return schema;
  const constraints = {
    string: stringKeys,
    number: numberKeys,
    integer: numberKeys,
    object: objectKeys,
    array: arrayKeys,
  }[target];
  for (const key of Object.keys(node)) {
    if (annotations.has(key) || constraints?.has(key)) continue;
    if (literals.has(key)) {
      const value = node[key];
      if (
        ["examples", "enum"].includes(key)
          ? Array.isArray(value) &&
            value.every((entry) => matchesLiteral(entry, target))
          : matchesLiteral(value, target)
      )
        continue;
    }
    throw Error("该类型会与现有字段约束或值冲突，请用 Raw 编辑");
  }
  return editSchemaNode(schema, row.path, { type: target });
}

export function modelFieldTypeMenuHTML() {
  return '<div id="model-field-type-menu" class="model-field-type-menu" popover role="menu" aria-label="字段类型"></div>';
}

export function bindModelFieldTypeMenu(container, { active, choose, notify }) {
  const menu = container?.querySelector("#model-field-type-menu");
  if (!menu) return;
  let options = [],
    anchor;
  const open = () => menu.matches(":popover-open");
  const focusOption = (index) => {
    for (const [position, option] of options.entries())
      option.tabIndex = position === index ? 0 : -1;
    options[index].focus({ preventScroll: true });
  };
  const clear = () => {
    anchor?.setAttribute("aria-expanded", "false");
    anchor = undefined;
    options = [];
    menu.replaceChildren();
  };
  const dismiss = (restoreFocus = false) => {
    const previous = anchor;
    if (open()) menu.hidePopover();
    clear();
    if (restoreFocus && previous?.isConnected)
      previous.focus({ preventScroll: true });
  };
  menu.addEventListener("toggle", () => {
    if (!open()) clear();
  });
  for (const trigger of container.querySelectorAll(
    "[data-model-type-trigger]",
  )) {
    const show = () => {
      if (!active() || !container.isConnected) return;
      if (open() && anchor === trigger) return dismiss(true);
      dismiss();
      anchor = trigger;
      trigger.setAttribute("aria-expanded", "true");
      const current = trigger.dataset.modelTypeCurrent;
      menu.innerHTML = orderedTypes
        .map(
          (type) =>
            `<button type="button" role="menuitemradio" aria-checked="${type === current}" tabindex="-1" data-model-type-option="${type}">${type}</button>`,
        )
        .join("");
      options = [...menu.querySelectorAll("[data-model-type-option]")];
      menu.showPopover();
      focusOption(
        options.findIndex(
          (option) => option.dataset.modelTypeOption === current,
        ),
      );
    };
    trigger.addEventListener("click", show);
    trigger.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      show();
    });
  }
  menu.addEventListener("keydown", (event) => {
    if (!anchor) return;
    const index = options.indexOf(event.target);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
      return;
    }
    if (event.key === "Tab") {
      // Move relative to the original position instead of the detached menu.
      dismiss(true);
      return;
    }
    const next = {
      Home: 0,
      End: options.length - 1,
      ArrowDown: (index + 1) % options.length,
      ArrowUp: (index + options.length - 1) % options.length,
    }[event.key];
    if (!Number.isInteger(next)) return;
    event.preventDefault();
    focusOption(next);
  });
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-model-type-option]");
    if (!option || !active() || !anchor || !container.isConnected || !open())
      return;
    try {
      const index = Number(anchor.dataset.modelTypeTrigger),
        target = option.dataset.modelTypeOption;
      dismiss(true);
      choose(index, target);
    } catch (error) {
      notify(error.message);
    }
  });
}
