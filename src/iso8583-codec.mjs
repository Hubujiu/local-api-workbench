import {
  Iso8583,
  N,
  ANS,
  B,
  LLVARn,
  LLLVARn,
  LLVARans,
  LLLVARans,
  LLVARb,
  LLLVARb,
  bitmap,
  NumericEncoding,
  VarLenHeaderEncoding,
  VarPayloadEncoding,
  VarLenCountMode,
} from "@tikpay/iso8583-ts";
const plain = (x) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(x));
const fieldNumber = (key) =>
  key !== "65" && /^(?:[2-9]|[1-9]\d|1[01]\d|12[0-8])$/.test(key);
function keys(input, allowed) {
  if (!plain(input) || Object.keys(input).some((k) => !allowed.includes(k)))
    throw Error("ISO8583 配置字段无效");
}
const variable = {
  llvarNumeric: LLVARn,
  lllvarNumeric: LLLVARn,
  llvarText: LLVARans,
  lllvarText: LLLVARans,
  llvarBinary: LLVARb,
  lllvarBinary: LLLVARb,
};
function profileCodec(profile) {
  keys(profile, ["fields", "mtiEncoding", "bitmapBytes", "lengthPrefix"]);
  if (!plain(profile.fields) || Object.keys(profile.fields).length > 127)
    throw Error("ISO8583 字段配置无效");
  const mtiEncoding = profile.mtiEncoding ?? "ascii",
    bitmapBytes = profile.bitmapBytes ?? 16,
    lengthPrefix = profile.lengthPrefix ?? true;
  if (
    !["ascii", "bcd"].includes(mtiEncoding) ||
    ![8, 16].includes(bitmapBytes) ||
    typeof lengthPrefix !== "boolean"
  )
    throw Error("ISO8583 头部配置无效");
  const spec = {
    0: {
      name: "MTI",
      format: N(4, {
        encoding:
          mtiEncoding === "ascii" ? NumericEncoding.ASCII : NumericEncoding.BCD,
      }),
    },
    1: { name: "Bitmap", format: bitmap(bitmapBytes) },
  };
  for (const [key, field] of Object.entries(profile.fields)) {
    if (!fieldNumber(key) || Number(key) > bitmapBytes * 8)
      throw Error("ISO8583 数据域编号超出位图范围");
    keys(field, ["kind", "length", "encoding", "lengthEncoding", "name"]);
    if (
      !Number.isInteger(field.length) ||
      field.length < 1 ||
      field.length > 999
    )
      throw Error("ISO8583 字段长度须为1至999");
    if (
      field.name !== undefined &&
      (typeof field.name !== "string" || field.name.length > 100)
    )
      throw Error("ISO8583 字段名称无效");
    if (typeof field.kind !== "string") throw Error("ISO8583 字段类型无效");
    const numeric = field.kind === "numeric" || field.kind?.endsWith("Numeric"),
      binary = field.kind === "binary" || field.kind?.endsWith("Binary");
    const encoding = field.encoding ?? "ascii",
      lengthEncoding = field.lengthEncoding ?? "ascii";
    if (
      !["ascii", "bcd"].includes(encoding) ||
      !["ascii", "bcd"].includes(lengthEncoding) ||
      (!numeric && encoding !== "ascii")
    )
      throw Error("ISO8583 编码配置无效");
    let format;
    if (field.kind === "numeric")
      format = N(field.length, {
        encoding:
          encoding === "ascii" ? NumericEncoding.ASCII : NumericEncoding.BCD,
      });
    else if (field.kind === "text") format = ANS(field.length);
    else if (field.kind === "binary") format = B(field.length);
    else if (Object.hasOwn(variable, field.kind))
      format = variable[field.kind]({
        length: field.length,
        lenHeader:
          lengthEncoding === "ascii"
            ? VarLenHeaderEncoding.ASCII
            : VarLenHeaderEncoding.BCD,
        payload: binary
          ? VarPayloadEncoding.BINARY
          : numeric && encoding === "bcd"
            ? VarPayloadEncoding.BCD_DIGITS
            : VarPayloadEncoding.ASCII,
        lenCountMode: numeric ? VarLenCountMode.DIGITS : VarLenCountMode.BYTES,
      });
    else throw Error("ISO8583 字段类型未支持");
    spec[key] = { name: field.name ?? "DE" + key, format };
  }
  return { codec: new Iso8583(spec), lengthPrefix };
}
function values(profile, fields) {
  if (!plain(fields) || Object.keys(fields).length > 127)
    throw Error("ISO8583 字段值无效");
  const result = {};
  for (const [key, value] of Object.entries(fields)) {
    if (
      !fieldNumber(key) ||
      !Object.hasOwn(profile.fields, key) ||
      typeof value !== "string" ||
      value.length > 1998
    )
      throw Error("ISO8583 未声明字段或字段值无效");
    const kind = profile.fields[key].kind,
      binary = kind === "binary" || kind.endsWith("Binary"),
      numeric = kind === "numeric" || kind.endsWith("Numeric");
    if (binary) {
      if (value.length % 2 || !/^[0-9a-f]*$/i.test(value))
        throw Error("ISO8583 二进制字段必须是完整十六进制字节");
      result[key] = Buffer.from(value, "hex");
    } else {
      if (numeric ? !/^\d*$/.test(value) : !/^[\x20-\x7e]*$/.test(value))
        throw Error("ISO8583 字段须为数字或可打印 ASCII，不能静默替换 Unicode");
      result[key] = value;
    }
  }
  return result;
}
export function encodeISO8583(input) {
  keys(input, ["format", "profile", "mti", "fields"]);
  if (
    input.format !== "iso8583" ||
    typeof input.mti !== "string" ||
    !/^\d{4}$/.test(input.mti)
  )
    throw Error("ISO8583 MTI 必须是4位数字");
  const { codec, lengthPrefix } = profileCodec(input.profile);
  const body = codec.pack(input.mti, values(input.profile, input.fields)).bytes;
  if (body.length > 65535) throw Error("ISO8583 报文超过65535字节");
  if (!lengthPrefix) return body;
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(body.length);
  return Buffer.concat([prefix, body]);
}
export function decodeISO8583(profile, buffer) {
  if (!(buffer instanceof Uint8Array) || buffer.length > 65537)
    throw Error("ISO8583 接收报文无效或超限");
  const { codec, lengthPrefix } = profileCodec(profile);
  let body = Buffer.from(buffer);
  if (lengthPrefix) {
    if (body.length < 2 || body.readUInt16BE(0) !== body.length - 2)
      throw Error("ISO8583 长度头与实际数据不一致");
    body = body.subarray(2);
  }
  if (body.length > 65535) throw Error("ISO8583 报文超过65535字节");
  const decoded = codec.unpack(body);
  // The upstream decoder can return bytesRead beyond a truncated input or leave
  // trailing bytes. Require complete consumption and canonical re-encoding.
  if (decoded.bytesRead !== body.length || !/^\d{4}$/.test(decoded.mti))
    throw Error("ISO8583 报文截断或存在尾随数据");
  const fields = Object.fromEntries(
    Object.entries(decoded.fields).map(([key, value]) => [
      key,
      Buffer.isBuffer(value) ? value.toString("hex") : value,
    ]),
  );
  const canonical = codec.pack(decoded.mti, values(profile, fields)).bytes;
  if (!canonical.equals(body))
    throw Error("ISO8583 报文不能无损往返，编码或字段配置不匹配");
  return { mti: decoded.mti, fields, bytesRead: buffer.length };
}
