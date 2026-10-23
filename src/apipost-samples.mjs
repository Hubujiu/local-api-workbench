// Root-level, complete HTTP sample definitions only. No source application code runs.
export function prepareModernSamples(
  rows,
  apiNodes,
  projectId,
  servers,
  resource,
) {
  if (!Array.isArray(rows) || rows.length > 1000)
    throw Error("Apipost样例最多1000项");
  const descriptors = Object.getOwnPropertyDescriptors(rows);
  if (
    Object.getPrototypeOf(rows) !== Array.prototype ||
    Reflect.ownKeys(rows).length !== rows.length + 1
  )
    throw Error("Apipost样例须为连续普通数组");
  for (let i = 0; i < rows.length; i++)
    if (!descriptors[i]?.enumerable || !Object.hasOwn(descriptors[i], "value"))
      throw Error("Apipost样例数组不能含空洞或访问器");
  const apiIds = new Map(
    apiNodes.map((node) => [String(node?.target_id), node]),
  );
  const sampleIds = new Set(),
    byNode = new Map();
  const entries = rows.map((sample, index) => {
    if (
      !sample ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(sample))
    )
      throw Error("Apipost样例须为普通对象");
    const fields = Object.getOwnPropertyDescriptors(sample);
    for (const key of Reflect.ownKeys(sample))
      if (
        typeof key !== "string" ||
        ![
          "sample_id",
          "parent_id",
          "target_id",
          "project_id",
          "name",
          "type",
          "method",
          "url",
          "sort",
          "description",
          "protocol",
          "request",
          "response",
        ].includes(key) ||
        !fields[key].enumerable ||
        !Object.hasOwn(fields[key], "value")
      )
        throw Error("Apipost样例包含未知字段或访问器");
    const id = sample.sample_id;
    if (
      typeof id !== "string" ||
      !id.trim() ||
      id.length > 200 ||
      sampleIds.has(id)
    )
      throw Error("Apipost样例标识无效或重复");
    sampleIds.add(id);
    if (sample.project_id !== undefined && sample.project_id !== projectId)
      throw Error("Apipost样例项目来源不匹配");
    if (sample.type !== undefined && sample.type !== "sample")
      throw Error("Apipost样例分组或其他样例类型暂不支持");
    if (
      sample.parent_id !== undefined &&
      !["0", ""].includes(String(sample.parent_id))
    )
      throw Error("Apipost嵌套样例暂不支持");
    const origin = apiIds.get(String(sample.target_id));
    if (!origin || origin.target_type !== "api")
      throw Error("Apipost样例关联接口不存在");
    if (
      typeof sample.name !== "string" ||
      !sample.name.trim() ||
      sample.name.length > 200 ||
      typeof sample.method !== "string" ||
      !sample.method.trim() ||
      typeof sample.url !== "string" ||
      !sample.url
    )
      throw Error("Apipost样例须有明确名称、方法与URL");
    if (
      sample.description !== undefined &&
      typeof sample.description !== "string"
    )
      throw Error("Apipost样例说明须为文本");
    if (
      sample.protocol !== undefined &&
      !["http/1.1", "http/2"].includes(sample.protocol)
    )
      throw Error("Apipost样例协议暂不支持");
    const sort = sample.sort === undefined ? index : sample.sort;
    if (!Number.isFinite(sort) || Math.abs(sort) > 1e9)
      throw Error("Apipost样例排序无效");
    if (
      !sample.request ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(sample.request))
    )
      throw Error("Apipost样例须包含完整请求定义");
    if (
      sample.response !== undefined &&
      (!sample.response ||
        ![Object.prototype, null].includes(
          Object.getPrototypeOf(sample.response),
        ) ||
        Object.keys(sample.response).some((key) => key !== "example"))
    )
      throw Error("Apipost样例响应包含未支持的字段");
    if (sample.url.startsWith("/")) {
      if (
        sample.url.startsWith("//") ||
        servers.length !== 1 ||
        String(servers[0].server_id) !== "1"
      )
        throw Error("Apipost相对样例目前仅支持明确的默认单服务");
      const seen = new Set();
      let parent = String(origin.parent_id ?? "0");
      while (parent && parent !== "0") {
        if (seen.has(parent) || seen.size >= 30)
          throw Error("Apipost样例祖先目录成环或过深");
        seen.add(parent);
        const folder = apiIds.get(parent);
        if (!folder || folder.target_type !== "folder")
          throw Error("Apipost样例祖先目录不存在");
        if (
          folder.server_id !== undefined &&
          !["0", "1"].includes(String(folder.server_id))
        )
          throw Error("Apipost样例目录服务绑定暂不支持");
        parent = String(folder.parent_id ?? "0");
      }
    }
    const nodeId = resource("sample-node", id);
    if (apiIds.has(nodeId) || byNode.has(nodeId))
      throw Error("Apipost样例派生标识冲突");
    byNode.set(nodeId, {
      id: resource("sample", id),
      name: sample.name,
      sourceOperationId: "apipost:" + String(sample.target_id),
      sampleId: id,
    });
    return {
      sort,
      index,
      node: {
        target_id: nodeId,
        target_type: "api",
        parent_id: origin.parent_id ?? "0",
        name: sample.name,
        method: sample.method,
        url: sample.url,
        description: sample.description ?? "",
        protocol: sample.protocol ?? "http/1.1",
        request: structuredClone(sample.request),
        response: structuredClone(sample.response ?? {}),
      },
    };
  });
  entries.sort((a, b) => a.sort - b.sort || a.index - b.index);
  return { nodes: entries.map((entry) => entry.node), byNode };
}
