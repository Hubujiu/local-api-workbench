import { encodeISO8583, decodeISO8583 } from "./iso8583-codec.mjs";
const MAX = 1024 * 1024;
const plain = (x) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(x));
function text(value) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    Buffer.byteLength(value) > MAX
  )
    throw Error("协议文本必须是有效 UTF-8，最多1MiB");
  return value;
}
function keys(value, allowed) {
  if (!plain(value) || Object.keys(value).some((k) => !allowed.includes(k)))
    throw Error("协议消息格式或字段无效");
}
export function protocolPayload(value = "") {
  if (typeof value === "string")
    return { buffer: Buffer.from(text(value)), binary: false };
  if (!plain(value)) throw Error("协议消息必须是文本或显式编码对象");
  if (value.format === "iso8583") {
    const profile = structuredClone(value.profile);
    return {
      buffer: encodeISO8583({ ...value, profile }),
      binary: true,
      decode: (buffer) => decodeISO8583(profile, buffer),
    };
  }
  if (value.encoding !== undefined) {
    keys(value, ["encoding", "data"]);
    if (value.encoding === "utf8")
      return { buffer: Buffer.from(text(value.data)), binary: false };
    if (typeof value.data !== "string") throw Error("协议二进制数据无效");
    let buffer;
    if (value.encoding === "hex") {
      if (
        value.data.length > MAX * 2 ||
        value.data.length % 2 ||
        !/^[0-9a-f]*$/i.test(value.data)
      )
        throw Error("协议十六进制格式无效或超限");
      buffer = Buffer.from(value.data, "hex");
    } else if (value.encoding === "base64") {
      if (value.data.length > Math.ceil(MAX / 3) * 4)
        throw Error("协议二进制消息超过1MiB");
      buffer = Buffer.from(value.data, "base64");
      if (buffer.toString("base64") !== value.data)
        throw Error("协议 Base64 格式无效");
    } else throw Error("协议消息编码无效");
    if (buffer.length > MAX) throw Error("协议消息超过1MiB");
    return { buffer, binary: true };
  }
  if (value.format === "delimited") {
    keys(value, ["format", "fields", "delimiter", "trailing"]);
    if (
      !Array.isArray(value.fields) ||
      value.fields.length > 1000 ||
      typeof value.delimiter !== "string" ||
      !value.delimiter.isWellFormed() ||
      Buffer.byteLength(value.delimiter) > 8 ||
      (value.trailing !== undefined && typeof value.trailing !== "boolean")
    )
      throw Error("分隔报文配置无效");
    const fields = value.fields.map(text),
      count =
        Math.max(0, fields.length - 1) +
        (value.trailing && fields.length ? 1 : 0);
    if (
      fields.reduce((n, x) => n + Buffer.byteLength(x), 0) +
        count * Buffer.byteLength(value.delimiter) >
      MAX
    )
      throw Error("协议消息超过1MiB");
    return {
      buffer: Buffer.from(
        fields.join(value.delimiter) +
          (value.trailing && fields.length ? value.delimiter : ""),
      ),
      binary: false,
    };
  }
  if (value.format === "fixed") {
    keys(value, ["format", "fields"]);
    if (!Array.isArray(value.fields) || value.fields.length > 1000)
      throw Error("定长报文字段无效");
    let total = 0;
    const fields = value.fields.map((field) => {
      keys(field, ["value", "width", "pad", "align"]);
      text(field.value);
      if (
        !Number.isInteger(field.width) ||
        field.width < 0 ||
        field.width > MAX ||
        (field.align !== undefined && !["left", "right"].includes(field.align))
      )
        throw Error("定长报文字段宽度或对齐无效");
      const pad = field.pad ?? " ";
      if (
        typeof pad !== "string" ||
        Buffer.byteLength(pad) !== 1 ||
        !pad.isWellFormed()
      )
        throw Error("定长填充符必须为单字节文本");
      total += field.width;
      if (total > MAX) throw Error("协议消息超过1MiB");
      const size = Buffer.byteLength(field.value);
      if (size > field.width)
        throw Error("定长字段内容超过指定字节宽度，不会静默截断");
      const fill = pad.repeat(field.width - size);
      return field.align === "right" ? fill + field.value : field.value + fill;
    });
    return { buffer: Buffer.from(fields.join("")), binary: false };
  }
  throw Error("未支持的协议报文格式");
}
