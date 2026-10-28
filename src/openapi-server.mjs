const maxBytes = 65536;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Select first, then materialize only that server. Never consult runtime scopes.
export function openAPIServerURL(...levels) {
  for (const servers of levels) {
    if (servers === undefined) continue;
    if (!Array.isArray(servers)) throw Error("OpenAPI servers必须为数组");
    if (!servers.length) continue;
    const server = servers[0];
    if (
      !record(server) ||
      typeof server.url !== "string" ||
      !server.url ||
      Buffer.byteLength(server.url) > maxBytes
    )
      throw Error("OpenAPI server URL须为非空文本且不超过64KiB");
    const variables = server.variables === undefined ? {} : server.variables;
    if (!record(variables) || Object.keys(variables).length > 1000)
      throw Error("OpenAPI server variables须为对象且最多1000项");
    for (const [name, variable] of Object.entries(variables)) {
      if (
        !name ||
        /[{}]/.test(name) ||
        !record(variable) ||
        !Object.hasOwn(variable, "default") ||
        typeof variable.default !== "string"
      )
        throw Error("OpenAPI server variable必须具有字符串default");
      // Braces would become path/runtime placeholders (including on export).
      // Reject rather than recursively expanding or changing literal URL bytes.
      if (/[{}]|%7[bd]/i.test(variable.default))
        throw Error("OpenAPI server variable default暂不支持花括号字面量");
      if (Buffer.byteLength(variable.default) > maxBytes)
        throw Error("OpenAPI server variable default超过64KiB");
    }
    let bytes = Buffer.byteLength(server.url),
      tokens = 0;
    const resolved = server.url.replace(
      /\{\{[^{}]+\}\}|\{[^{}]+\}|[{}]/g,
      (token) => {
        if (++tokens > 1000) throw Error("OpenAPI server URL最多1000个占位符");
        if (token.startsWith("{{")) {
          const name = token.slice(2, -2).trim();
          if (!name || Object.hasOwn(variables, name))
            throw Error("OpenAPI server URL双花括号变量存在歧义");
          // Native interchange may contain an existing workbench base variable.
          return token;
        }
        if (token.length < 3) throw Error("OpenAPI server URL花括号格式无效");
        const name = token.slice(1, -1);
        if (!Object.hasOwn(variables, name))
          throw Error("OpenAPI server URL变量缺少default定义");
        const value = variables[name].default;
        bytes += Buffer.byteLength(value) - Buffer.byteLength(token);
        if (bytes > maxBytes) throw Error("OpenAPI server URL展开后超过64KiB");
        // A callback preserves $&, $`, $' and performs no recursive substitution.
        return value;
      },
    );
    const literal = resolved.replace(/\{\{[^{}]+\}\}/g, "workbench");
    if (/[\u0000-\u001f\u007f]/.test(resolved))
      throw Error("OpenAPI server URL不能包含控制字符");
    if (literal.includes("\\"))
      throw Error("OpenAPI server URL暂不支持反斜杠字面量");
    if (/%7[bd]/i.test(literal))
      throw Error("OpenAPI server URL暂不支持编码后的花括号字面量");
    if (/[?#]/.test(literal))
      throw Error("OpenAPI server URL暂不支持Query或片段，请使用操作参数");
    if (/%(?![0-9a-f]{2})/i.test(literal))
      throw Error("OpenAPI server URL百分号编码无效");
    if (!resolved.includes("{{") && /^https?:\/\//i.test(resolved)) {
      try {
        new URL(resolved);
      } catch {
        throw Error("OpenAPI server URL展开后无效");
      }
    }
    return resolved;
  }
  return undefined;
}
