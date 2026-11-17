import { validateModelFolders } from "./model-folders.js";
export function saveModel(project, index, input, newId) {
  const dictionary = project.dictionary || [];
  if (
    !Array.isArray(dictionary) ||
    (index !== undefined &&
      (!Number.isInteger(index) || index < 0 || index >= dictionary.length))
  )
    throw Error("数据模型不存在");
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.trim().length > 500
  )
    throw Error("模型名称须为1至500个字符");
  if (
    dictionary.some(
      (model, i) =>
        i !== index &&
        typeof model.name === "string" &&
        model.name.trim() === input.name.trim(),
    )
  )
    throw Error("模型名称重复，请使用不同名称");
  if (
    typeof input.schema !== "boolean" &&
    (!input.schema ||
      typeof input.schema !== "object" ||
      Array.isArray(input.schema))
  )
    throw Error("模型Schema须为对象或布尔值");
  if (
    new TextEncoder().encode(JSON.stringify(input.schema)).length >
    1024 * 1024
  )
    throw Error("模型Schema最多1MiB UTF-8");
  const previous = index === undefined ? {} : dictionary[index];
  const id = previous.id || newId;
  if (
    typeof id !== "string" ||
    !id ||
    id.length > 200 ||
    ["__proto__", "prototype", "constructor"].includes(id)
  )
    throw Error("模型ID无效");
  if (dictionary.some((model, i) => i !== index && model.id === id))
    throw Error("模型ID重复");
  const value = {
    ...previous,
    id,
    name: input.name.trim(),
    schema: structuredClone(input.schema),
    ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
  };
  const next = dictionary.slice();
  if (index === undefined) next.push(value);
  else next[index] = value;
  validateModelFolders({ ...project, dictionary: next });
  const linked =
    previous.id &&
    Object.hasOwn(project.openapiComponents?.schemas || {}, previous.id);
  const components = linked
    ? {
        ...project.openapiComponents,
        schemas: {
          ...project.openapiComponents.schemas,
          [previous.id]: structuredClone(input.schema),
        },
      }
    : null;
  project.dictionary = next;
  if (linked) project.openapiComponents = components;
  return value;
}
