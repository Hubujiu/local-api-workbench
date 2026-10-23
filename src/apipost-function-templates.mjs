import { parseApipostFunctionTemplate } from "../public/apipost-function-template.js";
import { validateResources } from "./resources.mjs";
import { runScript } from "./scripts.mjs";
export async function resolveApipostFunctionTemplate(
  expression,
  functions,
  group = "query",
) {
  if (!["query", "headers", "form"].includes(group))
    throw Error("原版函数模板参数位置无效");
  const { name, argument } = parseApipostFunctionTemplate(expression);
  const matches = functions.filter((fn) => fn.name?.toLowerCase() === name);
  if (matches.length !== 1 || !matches[0].apipostSource)
    throw Error("原版函数模板必须引用唯一的已导入共享函数: " + name);
  const fn = matches[0];
  validateResources({ functions: [fn] });
  // Deliberately do not use the direct-script wrapper, which catches to input text.
  // Template calls have a different synchronous-error fallback and are not awaited.
  const code = `
    let output;
    try { output=(function(text){\n${fn.body}\n})(${JSON.stringify(argument)}); }
    catch(error) { output=${JSON.stringify(expression)}; }
    if (!['string','number','boolean'].includes(typeof output) && output !== null)
      throw Error('原版函数模板暂仅支持同步基本类型结果');
    if (typeof output === 'number' && !Number.isFinite(output)) throw Error('原版函数模板结果必须有限');
    apt.setVar('functionTemplateResult', output);
  `;
  const result = await runScript(
    code,
    { functions: [], variables: {} },
    { requestLimit: 0, timerLimit: 0, jobLimit: 0 },
  );
  const value = result.variables.functionTemplateResult;
  if (
    (!["string", "number", "boolean"].includes(typeof value) &&
      value !== null) ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    throw Error("原版函数模板暂仅支持有限同步基本类型结果");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 65536)
    throw Error("原版函数模板结果超过64KiB");
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (
    (group !== "form" && /[\r\n]/.test(text)) ||
    (group === "query" && /[&#+%?=]/.test(text)) ||
    (text !== expression && text.includes("$"))
  )
    throw Error("原版函数结果包含尚未兼容的分隔符或替换符，不发送不等价请求");
  return value;
}
