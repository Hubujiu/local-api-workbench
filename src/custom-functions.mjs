import { runScript } from "./scripts.mjs";
export async function previewFunction(fn, value) {
  if (!fn || typeof fn !== "object") throw Error("函数定义无效");
  const input = JSON.stringify(value);
  if (input === undefined || input.length > 65536)
    throw Error("测试输入须为不超过64KiB的JSON值");
  const code = `
    const output = utils[${JSON.stringify(fn.name)}](${input});
    const serial = JSON.stringify(output, (_key, value) => {
      if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' ||
          typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value)))
        throw Error('函数结果必须是有限 JSON 值');
      return value;
    });
    if (serial === undefined || serial.length > 65536) throw Error('函数结果须为不超过64KiB的JSON值');
    apt.setVar('functionResult', JSON.parse(serial));
  `;
  const result = await runScript(code, { functions: [fn], variables: {} });
  return { value: result.variables.functionResult, logs: result.logs };
}
