import Handlebars from "handlebars";
// Runs only inside the existing QuickJS VM, never in the Node host.
export function renderVisualization(template, data = {}) {
  const bytes = (value, max) => {
    let size = 0;
    for (const character of value) {
      const code = character.codePointAt(0);
      size += code <= 127 ? 1 : code <= 2047 ? 2 : code <= 65535 ? 3 : 4;
      if (size > max) throw Error("可视化数据超过大小上限");
    }
  };
  if (typeof template !== "string")
    throw Error("可视化模板必须为字符串，不接受AST对象");
  bytes(template, 65536);
  const json = JSON.stringify(data);
  if (typeof json !== "string") throw Error("可视化数据必须可序列化");
  bytes(json, 262144);
  const engine = Handlebars.create();
  const html = engine.compile(template, { strict: true })(JSON.parse(json), {
    allowProtoMethodsByDefault: false,
    allowProtoPropertiesByDefault: false,
  });
  bytes(html, 262144);
  return html;
}
