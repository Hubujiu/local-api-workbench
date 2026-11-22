import { debugPairFromKey } from "./debug-pair-composer.js";
import { isDesignQueryScalarType } from "./design-query-metadata.js";

export const provisionalQueryDefaults = Object.freeze({
  type: "string",
  required: false,
  enabled: true,
});

export function changedProvisionalQuery(options) {
  return (
    options &&
    (options.type !== "string" || options.required || !options.enabled)
  );
}

export function createProvisionalQuery() {
  let project, request, options;
  return {
    observe(nextProject, nextRequest) {
      const owner = nextRequest?.query?.length === 0 ? nextRequest : null;
      if (nextProject === project && owner === request) return;
      project = nextProject;
      request = owner;
      options = Object.freeze({ ...provisionalQueryDefaults });
    },
    read(ownerProject, ownerRequest) {
      if (
        request &&
        project === ownerProject &&
        request === ownerRequest &&
        request.query.length === 0
      )
        return options;
    },
    update(ownerProject, ownerRequest, snapshot, next) {
      if (
        !request ||
        project !== ownerProject ||
        request !== ownerRequest ||
        request.query.length !== 0 ||
        options !== snapshot ||
        !isDesignQueryScalarType(next.type) ||
        typeof next.required !== "boolean" ||
        typeof next.enabled !== "boolean"
      )
        return false;
      options = Object.freeze({
        type: next.type,
        required: next.required,
        enabled: next.enabled,
      });
      return true;
    },
  };
}

export function provisionalQueryRow(name, options = provisionalQueryDefaults) {
  const row = debugPairFromKey(name);
  if (!row) return null;
  row.enabled = options.enabled;
  if (options.type !== "string") row.schema = { type: options.type };
  if (options.required) row.required = true;
  return row;
}

export function provisionalQueryEnabled(options, header = false) {
  return `<input type="checkbox" class="design-provisional-query-enable" data-design-query-draft-enabled="${header ? "header" : "row"}" ${options.enabled ? "checked" : ""} aria-label="${header ? "启用待命名 Query 参数（表头）" : "启用待命名 Query 参数"}">`;
}

export function provisionalQueryType(options) {
  return `<button type="button" class="ghost design-query-type" data-design-query-draft-type data-design-query-current="${options.type}" data-query-type-color="${options.type}" aria-label="更改待命名 Query 参数的类型：${options.type}" aria-haspopup="menu" aria-expanded="false" aria-controls="design-query-type-menu">${options.type}</button>`;
}

export function provisionalQueryRequired(options) {
  return `<button type="button" class="ghost design-query-required" data-design-query-draft-required aria-pressed="${options.required}" title="是否必填" aria-label="待命名 Query 参数必填"><span aria-hidden="true">*</span></button>`;
}

export function provisionalQueryNotice(options) {
  return changedProvisionalQuery(options)
    ? '<div class="design-query-provisional-notice"><p role="status">待命名 Query 参数选项尚未加入接口；填写参数名后才能保存。</p><button type="button" class="ghost" data-design-query-draft-reset>重置待命名选项</button></div>'
    : "";
}
