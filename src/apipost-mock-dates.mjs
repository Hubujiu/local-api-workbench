const formats = Object.freeze({
  date: "yyyy-MM-dd",
  time: "HH:mm:ss",
  datetime: "yyyy-MM-dd HH:mm:ss",
});
const tokens = new Set([
  "yyyy",
  "yy",
  "MM",
  "M",
  "dd",
  "d",
  "HH",
  "H",
  "mm",
  "m",
  "ss",
  "s",
]);
export function parseApipostMockDate(kind, args) {
  if (
    !Object.hasOwn(formats, kind) ||
    !Array.isArray(args) ||
    args.length > 1 ||
    (args.length && typeof args[0] !== "string")
  )
    throw Error("原版日期Mock仅支持一个数值格式字符串");
  const format = args[0] || formats[kind];
  if (
    format.length > 64 ||
    (format.match(/([A-Za-z])\1*|[^A-Za-z]+/g) || []).some((token) =>
      /^[A-Za-z]/.test(token)
        ? !tokens.has(token)
        : !/^[-/: .0-9]+$/.test(token),
    )
  )
    throw Error("原版日期Mock格式仅支持有界数值日期/时间标记");
  return format;
}
export function sampleApipostMockDate(format, random, now = Date.now) {
  format = parseApipostMockDate("date", [format]);
  const clock = now();
  if (!Number.isSafeInteger(clock) || clock < 0 || clock > 8640000000000000)
    throw Error("原版日期Mock时钟超出支持范围");
  const value = random();
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value >= 1
  )
    throw Error("原版日期Mock随机值无效");
  const date = new Date(Math.floor(value * clock));
  const pad = (value) => String(value).padStart(2, "0");
  const fields = {
    yyyy: String(date.getFullYear()),
    yy: String(date.getFullYear()).slice(2),
    MM: pad(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    dd: pad(date.getDate()),
    d: String(date.getDate()),
    HH: pad(date.getHours()),
    H: String(date.getHours()),
    mm: pad(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: pad(date.getSeconds()),
    s: String(date.getSeconds()),
  };
  return format.replace(
    /yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s/g,
    (token) => fields[token],
  );
}
