import { replaceExactApipostTemplate } from "./apipost-template-replacement.mjs";
import {
  parseApipostFunctionTemplate,
  isApipostBuiltinStage,
  apipostTemplateStages,
} from "../public/apipost-function-template.js";
import { validateResources } from "./resources.mjs";
import { runScript } from "./scripts.mjs";
export async function resolveApipostFunctionTemplate(
  expression,
  functions,
  group = "query",
  variables = {},
) {
  if (!["query", "headers", "form", "body"].includes(group))
    throw Error("原版函数模板参数位置无效");
  const parsed = parseApipostFunctionTemplate(expression);
  const { name, argument, pipeline = [] } = parsed;
  const selected = apipostTemplateStages(parsed).map((name, index) => {
    if (isApipostBuiltinStage(name))
      return {
        name,
        builtin: true,
        argument:
          parsed.pipelineArguments?.[index - (parsed.name ? 1 : 0)] || "",
      };
    const matches = functions.filter((fn) => fn.name?.toLowerCase() === name);
    if (matches.length !== 1 || !matches[0].apipostSource)
      throw Error("原版函数模板必须引用唯一的已导入共享函数: " + name);
    return { name, fn: matches[0] };
  });
  validateResources({
    functions: [
      ...new Map(
        selected
          .filter((entry) => entry.fn)
          .map((entry) => [entry.name, entry.fn]),
      ).values(),
    ],
  });
  const baseExpression = pipeline.length
    ? expression.slice(0, expression.indexOf("|")) + "}}"
    : expression;
  let initial;
  if (!name) {
    if (parsed.variable) {
      const descriptor = Object.getOwnPropertyDescriptor(
        variables,
        parsed.variable,
      );
      if (descriptor && !Object.hasOwn(descriptor, "value"))
        throw Error("原版加工链不读取访问器变量");
      initial = descriptor?.value;
      if (initial === undefined) initial = baseExpression;
    } else initial = parsed.literal;
    if (
      (typeof initial !== "string" &&
        typeof initial !== "number" &&
        typeof initial !== "boolean" &&
        initial !== null) ||
      (typeof initial === "number" && !Number.isFinite(initial))
    )
      throw Error("原版加工链初值仅支持有限基本类型");
    if (Buffer.byteLength(JSON.stringify(initial), "utf8") > 65536)
      throw Error("原版加工链初值超过64KiB");
  }
  // Source pipelines preserve the previous value after a synchronous stage error.
  // Async and budget failures remain errors; checks run outside those catch blocks.
  const check = `
    if (typeof output !== 'string' && typeof output !== 'number' && typeof output !== 'boolean' && output !== null)
      throw Error('原版函数模板暂仅支持同步基本类型结果');
    if (typeof output === 'number' && !__apipostFinite(output)) throw Error('原版函数模板结果必须有限');
    { const serialized=__apipostStringify(output);let bytes=0;for(let i=0;i<serialized.length;i++){const cp=__apipostCharCode(serialized,i);if(cp>=55296 && cp<=56319){bytes+=4;i++;}else bytes+=cp<=127?1:cp<=2047?2:3;if(bytes>65536)throw Error('原版函数模板结果超过64KiB');} }
  `;
  const code = `
    const __apipostStringify=JSON.stringify.bind(JSON), __apipostFinite=Number.isFinite, __apipostCharCode=Function.prototype.call.bind(String.prototype.charCodeAt);
    ${selected.some((fn) => fn.builtin) ? `const __apipostBuiltinLibrary=require("lodash"), __apipostString=String, __apipostConcat=Function.prototype.call.bind(String.prototype.concat);const __apipostBuiltins=Object.freeze({lower:__apipostBuiltinLibrary.toLower,upper:__apipostBuiltinLibrary.toUpper,length:__apipostBuiltinLibrary.size,number:__apipostBuiltinLibrary.toNumber,concat:(value,text)=>__apipostConcat(__apipostString(value),text),lconcat:(value,text)=>__apipostConcat(text,__apipostString(value))});` : ""}
    let output;
    ${name ? `try { output=(function(text){\n${selected[0].fn.body}\n})(${JSON.stringify(argument)}); } catch(error) { output=${JSON.stringify(baseExpression)}; }` : `output=${Object.is(initial, -0) ? "-0" : JSON.stringify(initial)};`}
    ${check}
    ${selected
      .slice(name ? 1 : 0)
      .map(
        (fn) =>
          `{ const input=output;try{output=${fn.builtin ? `__apipostBuiltins.${fn.name}(input,${JSON.stringify(fn.argument)})` : `(function(text){\n${fn.fn.body}\n})(input)`};}catch(error){output=input;} ${check} }`,
      )
      .join("\n")}
    apt.setVar('functionTemplateResult', output);
  `;
  const result = await runScript(
    code,
    { functions: [], variables: {} },
    { requestLimit: 0, timerLimit: 0, jobLimit: 0 },
  );
  let value = result.variables.functionTemplateResult;
  if (
    (!["string", "number", "boolean"].includes(typeof value) &&
      value !== null) ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    throw Error("原版函数模板暂仅支持有限同步基本类型结果");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 65536)
    throw Error("原版函数模板结果超过64KiB");
  if (group !== "query" && typeof value === "string" && value !== expression)
    value = replaceExactApipostTemplate(expression, value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (
    (["query", "headers"].includes(group) && /[\r\n]/.test(text)) ||
    (group === "query" && /[&#+%?=]/.test(text)) ||
    (group === "query" && text !== expression && text.includes("$"))
  )
    throw Error("原版函数结果包含尚未兼容的分隔符或替换符，不发送不等价请求");
  return value;
}
