import {
  parseApipostMockDate,
  parseApipostMockNow,
  sampleApipostMockNow,
  sampleApipostMockDate,
} from "./apipost-mock-dates.mjs";
import {
  responseMediaEntries,
  selectJsonResponseMedia,
  isJsonResponseType,
} from "./response-media.mjs";
import { sampleFromSchema } from "./schema-sample.mjs";
import { randomUUID } from "node:crypto";
const types = [
  "any",
  "string",
  "integer",
  "number",
  "boolean",
  "object",
  "array",
];
const functions = new Set([
  "cname",
  "name",
  "telephone",
  "phone",
  "integer",
  "natural",
  "float",
  "email",
  "url",
  "guid",
  "uuid",
  "boolean",
  "word",
  "string",
  "date",
  "datetime",
  "ip",
  "image",
]);
function alternatives(pattern) {
  const output = [];
  function expand(value) {
    if (output.length >= 32) throw Error("通配符最多32个展开选项");
    let start = -1;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === "\\") {
        i++;
        continue;
      }
      if (value[i] === "{") {
        start = i;
        break;
      }
    }
    if (start < 0) {
      output.push(value);
      return;
    }
    const end = value.indexOf("}", start + 1);
    if (end < 0 || value.slice(start + 1, end).includes("{"))
      throw Error("通配符花括号无效");
    for (const part of value.slice(start + 1, end).split(","))
      expand(value.slice(0, start) + part + value.slice(end + 1));
  }
  expand(pattern);
  return output;
}
function compilePattern(pattern) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 200)
    throw Error("通配符须为1–200字符");
  return alternatives(pattern).map((value) => {
    const tokens = [],
      symbols = [...value];
    for (let i = 0; i < symbols.length; i++) {
      const c = symbols[i];
      if (c === "*") {
        if (tokens.at(-1)?.kind !== "star") tokens.push({ kind: "star" });
      } else if (c === "?") tokens.push({ kind: "any" });
      else if (c === "\\") {
        if (++i >= symbols.length) throw Error("通配符转义不完整");
        tokens.push({ kind: "literal", value: symbols[i] });
      } else if (c === "[") {
        const end = symbols.indexOf("]", i + 1);
        if (end < 0) throw Error("通配符方括号不完整");
        let chars = symbols.slice(i + 1, end),
          negate = chars[0] === "!";
        if (negate) chars = chars.slice(1);
        if (!chars.length) throw Error("通配符字符集为空");
        const ranges = [];
        for (let j = 0; j < chars.length; j++) {
          const low = chars[j].codePointAt(0);
          if (chars[j + 1] === "-" && j + 2 < chars.length) {
            const high = chars[j + 2].codePointAt(0);
            if (low > high) throw Error("通配符范围无效");
            ranges.push([low, high]);
            j += 2;
          } else ranges.push([low, low]);
        }
        tokens.push({ kind: "class", negate, ranges });
        i = end;
      } else tokens.push({ kind: "literal", value: c });
    }
    return tokens;
  });
}
function matchCompiled(patterns, name, budget, utf16 = false) {
  if (typeof name !== "string" || name.length > 200) return false;
  const chars = utf16 ? name.split("") : [...name];
  return patterns.some((tokens) => {
    let previous = new Uint8Array(chars.length + 1);
    previous[0] = 1;
    for (const token of tokens) {
      const next = new Uint8Array(chars.length + 1);
      if (token.kind === "star") next[0] = previous[0];
      for (let j = 1; j <= chars.length; j++) {
        if (--budget.remaining < 0) throw Error("Mock字段匹配超过计算预算");
        if (token.kind === "star") next[j] = previous[j] || next[j - 1];
        else {
          const code = chars[j - 1].codePointAt(0);
          const matches =
            token.kind === "any" ||
            (token.kind === "literal"
              ? token.value === chars[j - 1]
              : token.ranges.some(
                  ([low, high]) => code >= low && code <= high,
                ) !== token.negate);
          next[j] = previous[j - 1] && matches ? 1 : 0;
        }
      }
      previous = next;
    }
    return previous[chars.length] === 1;
  });
}
export function matchesFieldPattern(pattern, name) {
  return matchCompiled(compilePattern(pattern), name, { remaining: 2000000 });
}
function expression(source) {
  if (typeof source !== "string" || source.length > 200)
    throw Error("Mock表达式最多200字符");
  if (!source.startsWith("@")) {
    try {
      return { literal: JSON.parse(source) };
    } catch {
      return { literal: source };
    }
  }
  const match = source.match(/^@([A-Za-z]+)(?:\(([\s\S]*)\))?$/);
  if (!match || !functions.has(match[1].toLowerCase()))
    throw Error("不支持的Mock函数");
  const name = match[1].toLowerCase();
  let args;
  try {
    args = JSON.parse("[" + (match[2] || "") + "]");
  } catch {
    throw Error("Mock参数使用JSON字面量，字符串使用双引号");
  }
  const max = ["integer", "natural"].includes(name)
    ? 2
    : name === "float"
      ? 4
      : ["word", "string", "date", "datetime"].includes(name)
        ? 1
        : 0;
  if (
    args.length > max ||
    args.some((value) => value !== null && typeof value === "object")
  )
    throw Error("Mock函数参数不支持");
  if (["integer", "natural", "float"].includes(name)) {
    if (
      args
        .slice(0, 2)
        .some(
          (value) => typeof value !== "number" || !Number.isFinite(value),
        ) ||
      (args.length >= 2 && args[0] > args[1])
    )
      throw Error("Mock数值参数无效");
    if (
      args
        .slice(2)
        .some((value) => !Number.isInteger(value) || value < 0 || value > 6) ||
      (args.length === 4 && args[2] > args[3])
    )
      throw Error("Mock小数位须为0–6");
  }
  if (
    ["word", "string"].includes(name) &&
    args.length &&
    (!Number.isInteger(args[0]) || args[0] < 0 || args[0] > 1000)
  )
    throw Error("Mock字符串长度须为0–1000");
  if (
    ["date", "datetime"].includes(name) &&
    args.length &&
    ![
      "yyyy-MM-dd",
      "YYYY-MM-DD",
      "yyyy-MM-dd HH:mm:ss",
      "YYYY-MM-DD HH:mm:ss",
      "iso",
    ].includes(args[0])
  )
    throw Error("不支持的Mock日期格式");
  return { name, args };
}
function maskNativeClasses(value) {
  let valid = true;
  const masked = value.replace(/\[([^\[\]]*)\]/g, (_match, body) => {
    if (!/^!?([A-Za-z0-9_]+|[a-z]-[a-z]|[A-Z]-[A-Z]|[0-9]-[0-9])$/.test(body))
      valid = false;
    return "x";
  });
  return valid ? masked : "";
}
function nativeWildcardPattern(pattern) {
  const masked = maskNativeClasses(pattern);
  if (pattern.length > 100 || !/^[A-Za-z0-9_.*?{},-]+$/.test(masked))
    return false;
  let valid = true;
  const remaining = masked.replace(/\{([^{}]*)\}/g, (_match, body) => {
    const parts = body.split(",");
    if (parts.length < 2 || parts.some((part) => !part)) valid = false;
    return "x";
  });
  if (!valid || /[{},]/.test(remaining)) return false;
  return alternatives(pattern).every(
    (value) =>
      /^[A-Za-z_*?][A-Za-z0-9_.*?-]{0,99}$/.test(maskNativeClasses(value)) &&
      !value.includes("**"),
  );
}
function nativeStringExpression(value) {
  const match =
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= 4096 &&
    /^@(string|pick|character|char|word|title|sentence|paragraph|date|time|datetime|now|guid|uuid)(?:\(([\s\S]*)\))?$/.exec(
      value,
    );
  let args;
  try {
    args = match && JSON.parse("[" + (match[2] ?? "") + "]");
  } catch {}
  if (match && ["guid", "uuid"].includes(match[1])) {
    if (!Array.isArray(args) || args.length)
      throw Error("原版UUID Mock不支持参数");
    return { name: "uuid", args: [] };
  }
  if (match && match[1] === "now")
    return { name: "native-now", args: parseApipostMockNow(args) };
  if (match && ["date", "time", "datetime"].includes(match[1]))
    return {
      name: "native-date",
      args: [parseApipostMockDate(match[1], args)],
    };
  if (match && ["title", "sentence", "paragraph"].includes(match[1])) {
    const limit = match[1] === "paragraph" ? 8 : 32;
    if (
      !Array.isArray(args) ||
      args.length > 2 ||
      args.some(
        (value) => !Number.isSafeInteger(value) || value < 0 || value > limit,
      ) ||
      (args.length === 2 && args[0] > args[1])
    )
      throw Error("原版文本生成数量须为有界整数且范围有序");
    const defaults = match[1] === "sentence" ? [12, 18] : [3, 7];
    return {
      name: "native-text",
      args: [
        match[1],
        ...(args.length ? [args[0], args[1] ?? args[0]] : defaults),
      ],
    };
  }
  if (match && match[1] === "word") {
    if (
      !Array.isArray(args) ||
      args.length > 2 ||
      args.some(
        (value) => !Number.isSafeInteger(value) || value < 0 || value > 64,
      ) ||
      (args.length === 2 && args[0] > args[1])
    )
      throw Error("原版word仅支持0至64的整数长度或有序长度范围");
    return {
      name: "native-word",
      args: args.length ? [args[0], args[1] ?? args[0]] : [3, 10],
    };
  }
  if (match && ["character", "char"].includes(match[1])) {
    if (Array.isArray(args) && !args.length) args = ["undefined"];
    if (
      !Array.isArray(args) ||
      args.length !== 1 ||
      typeof args[0] !== "string" ||
      args[0].length < 1 ||
      args[0].length > 64 ||
      !/^[\x20-\x7e]+$/.test(args[0]) ||
      args[0].includes("@") ||
      ["__proto__", "constructor", "prototype"].includes(args[0].toLowerCase())
    )
      throw Error("原版character/char仅支持一个有界ASCII字符池或已知池别名");
    const lower = "abcdefghijklmnopqrstuvwxyz",
      upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      number = "0123456789",
      symbol = "!@#$%^&*()[]";
    const pools = {
      lower,
      upper,
      number,
      symbol,
      alpha: lower + upper,
      undefined: lower + upper + number + symbol,
    };
    const key = args[0].toLowerCase();
    const pool = Object.hasOwn(pools, key) ? pools[key] : args[0];
    return { name: "native-pick", args: pool.split("") };
  }
  if (match && match[1] === "pick") {
    if (
      !Array.isArray(args) ||
      args.length !== 1 ||
      !Array.isArray(args[0]) ||
      args[0].length < 1 ||
      args[0].length > 64 ||
      args[0].some(
        (value) =>
          typeof value !== "string" ||
          Buffer.byteLength(value, "utf8") > 256 ||
          /[\uD800-\uDFFF]/u.test(value) ||
          value.includes("@"),
      )
    )
      throw Error(
        "原版pick仅支持1至64个有界字符串候选项，不支持嵌套表达式或额外参数",
      );
    return { name: "native-pick", args: args[0] };
  }
  if (match?.[1] === "string" && Array.isArray(args) && !args.length)
    return {
      name: "native-pick",
      args: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split(
        "",
      ),
    };
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !Array.isArray(args) ||
    ![1, 2, 3].includes(args.length) ||
    typeof args[0] !== "string" ||
    args[0].length < 1 ||
    args[0].length > 64 ||
    !/^[A-Za-z0-9 _.-]+$/.test(args[0]) ||
    args
      .slice(1)
      .some(
        (value) => !Number.isSafeInteger(value) || value < 0 || value > 64,
      ) ||
    args[1] > (args[2] ?? args[1])
  )
    throw Error(
      "原版string仅支持无参数或ASCII字符池与可选0到64整数长度，参数须使用JSON字面量",
    );
  if (args.length === 1)
    return { name: "native-pick", args: args[0].split("") };
  return {
    name: "native-string",
    args: [args[0], args[1], args[2] ?? args[1]],
  };
}
export function normalizeMockFieldRules(rules = []) {
  if (!Array.isArray(rules) || rules.length > 100)
    throw Error("字段Mock规则最多100条");
  const ids = new Set();
  let tokens = 0;
  return rules.map((rule) => {
    if (!rule || typeof rule !== "object") throw Error("字段Mock规则无效");
    if (rule.apipostSource !== undefined) {
      const source = rule.apipostSource;
      if (
        !source ||
        typeof source !== "object" ||
        Array.isArray(source) ||
        Object.keys(source).some(
          (key) => !["projectId", "id", "matchType"].includes(key),
        ) ||
        [source.projectId, source.id].some(
          (value) => typeof value !== "string" || !value || value.length > 200,
        ) ||
        !["integer", "number", "string"].includes(rule.type) ||
        typeof rule.pattern !== "string" ||
        (source.matchType !== undefined && source.matchType !== "wildcard") ||
        !(source.matchType === "wildcard"
          ? nativeWildcardPattern(rule.pattern)
          : /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(rule.pattern)) ||
        typeof rule.mock !== "string" ||
        !(rule.type === "string"
          ? nativeStringExpression(rule.mock)
          : /^@(integer|natural)\(\s*-?\d+\s*,\s*-?\d+\s*\)$/.test(rule.mock) ||
            (rule.type === "number" &&
              /^@float\(\s*-?\d+\s*,\s*-?\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/.test(
                rule.mock,
              )))
      )
        throw Error(
          "Apipost自定义Mock暂仅支持精确或星号/问号/ASCII集合/候选项字段及integer/natural双整数或float四整数参数规则",
        );
      if (rule.type !== "string") {
        const values = rule.mock
          .slice(rule.mock.indexOf("(") + 1, -1)
          .split(",")
          .map(Number);
        if (
          values.some(
            (value) => !Number.isSafeInteger(value) || Math.abs(value) > 1e12,
          ) ||
          values[0] > values[1] ||
          (rule.mock.startsWith("@natural") && values[0] < 0) ||
          (rule.mock.startsWith("@float") &&
            (values.slice(0, 2).some((value) => Math.abs(value) > 1e6) ||
              values.slice(2).some((value) => value < 0 || value > 6) ||
              values[2] > values[3]))
        )
          throw Error("Apipost自定义Mock数值范围无效");
      }
    }
    const compiled = compilePattern(rule.pattern);
    tokens += compiled.reduce((sum, items) => sum + items.length, 0);
    if (tokens > 20000) throw Error("字段Mock通配符总复杂度超过上限");
    if (rule.apipostSource && rule.type === "string")
      nativeStringExpression(rule.mock);
    else expression(rule.mock);
    const type = rule.type || "any";
    if (!types.includes(type)) throw Error("字段Mock类型无效");
    const id = rule.id || randomUUID();
    if (typeof id !== "string" || id.length > 200 || ids.has(id))
      throw Error("字段Mock标识无效或重复");
    ids.add(id);
    return {
      id,
      name: String(rule.name || rule.pattern).slice(0, 200),
      pattern: rule.pattern,
      type,
      mock: rule.mock,
      enabled: rule.enabled !== false,
      ignoreCase: rule.ignoreCase === true,
      ...(rule.apipostSource
        ? { apipostSource: { ...rule.apipostSource } }
        : {}),
    };
  });
}
export function validateMockFieldSettings(settings = {}) {
  if (
    settings.mockSeed !== undefined &&
    (!Number.isInteger(settings.mockSeed) ||
      settings.mockSeed < 0 ||
      settings.mockSeed > 4294967295)
  )
    throw Error("Mock种子须为0–4294967295整数");
  if (
    settings.smartMockBuiltins !== undefined &&
    typeof settings.smartMockBuiltins !== "boolean"
  )
    throw Error("内置Mock开关必须为布尔值");
  return normalizeMockFieldRules(settings.mockFieldRules || []);
}
const builtins = [
  { pattern: "{name,*_name}", type: "string", mock: "@cname()" },
  { pattern: "{email,*_email}", type: "string", mock: "@email()" },
  {
    pattern: "{phone,telephone,mobile,*_phone}",
    type: "string",
    mock: "@telephone()",
  },
  {
    pattern: "{avatar,*_avatar,avatar_url,*_avatar_url}",
    type: "string",
    mock: "@image()",
  },
  { pattern: "{url,*_url}", type: "string", mock: "@url()" },
  { pattern: "{id,*_id}", type: "integer", mock: "@integer()" },
];
function fieldType(schema) {
  return Array.isArray(schema.type)
    ? schema.type.find((type) => type !== "null") || "null"
    : schema.type;
}
function validateValue(value, schema) {
  const type = fieldType(schema);
  if (value === null) {
    if (
      !type ||
      type === "null" ||
      schema.nullable ||
      (Array.isArray(schema.type) && schema.type.includes("null"))
    )
      return value;
    throw Error("Mock值与字段类型不符");
  }
  const valid =
    !type ||
    (type === "array"
      ? Array.isArray(value)
      : type === "object"
        ? typeof value === "object" && !Array.isArray(value)
        : type === "integer"
          ? Number.isSafeInteger(value)
          : type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : typeof value === type);
  if (!valid) throw Error("Mock值与字段类型不符");
  if (
    typeof value === "string" &&
    ((schema.minLength !== undefined && [...value].length < schema.minLength) ||
      (schema.maxLength !== undefined && [...value].length > schema.maxLength))
  )
    throw Error("Mock值不满足字符串长度约束");
  if (typeof value === "number") {
    if (
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum) ||
      (typeof schema.exclusiveMinimum === "number" &&
        value <= schema.exclusiveMinimum) ||
      (typeof schema.exclusiveMaximum === "number" &&
        value >= schema.exclusiveMaximum) ||
      (schema.exclusiveMinimum === true && value <= schema.minimum) ||
      (schema.exclusiveMaximum === true && value >= schema.maximum) ||
      (schema.multipleOf !== undefined &&
        Math.abs(
          value / schema.multipleOf - Math.round(value / schema.multipleOf),
        ) > 1e-8)
    )
      throw Error("Mock值不满足数值约束");
  }
  return value;
}
export function createFieldSampler(settings = {}, { now = Date.now } = {}) {
  const custom = validateMockFieldSettings(settings);
  const rules = [...custom, ...(settings.smartMockBuiltins ? builtins : [])]
    .filter((rule) => rule.enabled !== false)
    .map((rule) => ({
      ...rule,
      compiled: compilePattern(
        rule.ignoreCase ? rule.pattern.toLowerCase() : rule.pattern,
      ),
      expression:
        rule.apipostSource && rule.type === "string"
          ? nativeStringExpression(rule.mock)
          : expression(rule.mock),
    }));
  const budget = { remaining: 2000000 };
  let seed = (settings.mockSeed ?? 0) >>> 0;
  if (!seed) seed = 0x9e3779b9;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const integer = (min, max) => {
    if (
      !Number.isSafeInteger(min) ||
      !Number.isSafeInteger(max) ||
      min > max ||
      Math.abs(min) > 1e12 ||
      Math.abs(max) > 1e12
    )
      throw Error("Mock数值范围无效或过大");
    return min + Math.floor(random() * (max - min + 1));
  };
  const pick = (values) => values[integer(0, values.length - 1)];
  const word = (length) => {
    if (!Number.isInteger(length) || length < 0 || length > 1000)
      throw Error("Mock字符串长度须为0–1000");
    return Array.from({ length }, () =>
      pick("abcdefghijklmnopqrstuvwxyz"),
    ).join("");
  };
  const generate = (spec, schema) => {
    if (Object.hasOwn(spec, "literal")) return structuredClone(spec.literal);
    const { name, args } = spec;
    if (["integer", "natural", "float"].includes(name)) {
      const precision =
        name === "float" ? integer(args[2] ?? 2, args[3] ?? args[2] ?? 2) : 0;
      if (precision < 0 || precision > 6) throw Error("Mock小数位须为0–6");
      let min = Math.max(
        args[0] ?? schema.minimum ?? 0,
        schema.minimum ?? -Infinity,
        typeof schema.exclusiveMinimum === "number"
          ? schema.exclusiveMinimum
          : -Infinity,
      );
      let max = Math.min(
        args[1] ?? schema.maximum ?? 100,
        schema.maximum ?? Infinity,
        typeof schema.exclusiveMaximum === "number"
          ? schema.exclusiveMaximum
          : Infinity,
      );
      if (name === "natural") min = Math.max(0, min);
      const step = schema.multipleOf ?? 10 ** -precision;
      if (
        typeof step !== "number" ||
        !Number.isFinite(step) ||
        step <= 0 ||
        (name !== "float" && !Number.isInteger(step))
      )
        throw Error("Mock multipleOf组合请使用明确样例");
      let low = Math.ceil(min / step),
        high = Math.floor(max / step);
      if (
        (schema.exclusiveMinimum === true && low * step === schema.minimum) ||
        (typeof schema.exclusiveMinimum === "number" &&
          low * step === schema.exclusiveMinimum)
      )
        low++;
      if (
        (schema.exclusiveMaximum === true && high * step === schema.maximum) ||
        (typeof schema.exclusiveMaximum === "number" &&
          high * step === schema.exclusiveMaximum)
      )
        high--;
      return Number((integer(low, high) * step).toPrecision(15));
    }
    if (name === "cname")
      return (
        pick(["张", "李", "王", "陈", "赵", "林"]) +
        pick(["明", "安", "晨", "小雨", "子宁", "文清"])
      );
    if (name === "name")
      return (
        pick(["Alex", "Sam", "Taylor", "Jordan"]) +
        " " +
        pick(["Lee", "Chen", "Morgan"])
      );
    if (name === "phone" || name === "telephone")
      return "138" + Array.from({ length: 8 }, () => integer(0, 9)).join("");
    if (name === "email") return "user" + integer(1, 9999) + "@example.test";
    if (name === "url") return "https://example.test/" + word(8);
    if (name === "ip") return "192.0.2." + integer(1, 254);
    if (name === "boolean") return random() >= 0.5;
    if (name === "word" || name === "string")
      return word(
        args[0] ??
          Math.min(schema.maxLength ?? 8, Math.max(schema.minLength ?? 0, 8)),
      );
    if (name === "uuid" || name === "guid") {
      const hex = (n) =>
        Array.from({ length: n }, () => pick("0123456789abcdef")).join("");
      return (
        hex(8) +
        "-" +
        hex(4) +
        "-4" +
        hex(3) +
        "-" +
        pick("89ab") +
        hex(3) +
        "-" +
        hex(12)
      );
    }
    if (name === "image")
      return (
        "data:image/svg+xml," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#eee"/><circle cx="32" cy="24" r="12" fill="#999"/></svg>',
        )
      );
    const date = new Date(
      Date.UTC(2020, 0, 1) + integer(0, 3652) * 86400000,
    ).toISOString();
    if (
      args[0] !== undefined &&
      ![
        "yyyy-MM-dd",
        "YYYY-MM-DD",
        "yyyy-MM-dd HH:mm:ss",
        "YYYY-MM-DD HH:mm:ss",
        "iso",
      ].includes(args[0])
    )
      throw Error("不支持的Mock日期格式");
    return args[0] === "iso"
      ? date
      : args[0]?.includes("HH")
        ? date.slice(0, 19).replace("T", " ")
        : name === "date" || args[0]
          ? date.slice(0, 10)
          : date;
  };
  const nativeFloat = (args) => {
    const whole = integer(args[0], args[1]);
    const count = integer(args[2], args[3]);
    let fraction = "";
    for (let i = 0; i < count; i++)
      fraction += integer(i === count - 1 ? 1 : 0, 9);
    return Number(String(whole) + "." + fraction);
  };
  const nativeString = ([pool, min, max]) => {
    const characters = pool.split("");
    const count = Math.min(integer(min, max), characters.length);
    for (let i = 0; i < count; i++) {
      const j = integer(i, characters.length - 1);
      [characters[i], characters[j]] = [characters[j], characters[i]];
    }
    return characters.slice(0, count).join("");
  };
  const nativeText = ([kind, min, max]) => {
    const capitalize = (value) =>
      value.charAt(0).toUpperCase() + value.slice(1);
    const words = (count) =>
      Array.from({ length: count }, () => word(integer(3, 10)));
    const sentence = (count) => capitalize(words(count).join(" ")) + ".";
    const count = integer(min, max);
    const value =
      kind === "paragraph"
        ? Array.from({ length: count }, () => sentence(integer(12, 18))).join(
            " ",
          )
        : kind === "title"
          ? words(count).map(capitalize).join(" ")
          : sentence(count);
    if (Buffer.byteLength(value, "utf8") > 2048)
      throw Error("原版文本生成结果超过2KiB");
    return value;
  };
  const generateNative = (spec, schema) => {
    switch (spec.name) {
      case "native-now":
        return sampleApipostMockNow(spec.args, now);
      case "native-date":
        return sampleApipostMockDate(spec.args[0], random, now);
      case "native-text":
        return nativeText(spec.args);
      case "native-word":
        return word(integer(...spec.args));
      case "native-pick":
        return pick(spec.args);
      case "native-string":
        return nativeString(spec.args);
      case "float":
        return nativeFloat(spec.args);
      default:
        return generate(spec, schema);
    }
  };
  const nativeScope = (rule, name, schema, type) => {
    if (
      rule.type !== type ||
      schema.type !== rule.type ||
      (type !== "string" &&
        (schema.minimum !== undefined || schema.maximum !== undefined))
    )
      return false;
    if (rule.apipostSource.matchType === "wildcard") {
      if (name.startsWith(".") || name.includes("/")) return false;
      if (name.includes("\\"))
        throw Error("原版星号Mock规则暂不支持含反斜杠的字段名");
    }
    return true;
  };
  return (name, schema) => {
    if (schema.pattern) throw Error("pattern字段请提供明确example");
    const explicit = schema.mock;
    if (explicit !== undefined)
      return validateValue(
        generate(
          typeof explicit === "string"
            ? expression(explicit)
            : { literal: explicit },
          schema,
        ),
        schema,
      );
    if (!name) return undefined;
    const type = fieldType(schema);
    for (const rule of rules)
      if (
        (!rule.apipostSource || nativeScope(rule, name, schema, type)) &&
        (rule.type === "any" ||
          rule.type === type ||
          (rule.type === "number" && type === "integer")) &&
        matchCompiled(
          rule.compiled,
          rule.ignoreCase ? name.toLowerCase() : name,
          budget,
          rule.apipostSource?.matchType === "wildcard",
        )
      ) {
        if (
          rule.apipostSource &&
          rule.type !== "string" &&
          ["exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some(
            (key) => schema[key] !== undefined,
          )
        )
          throw Error(
            "原版数值Mock规则暂不支持排他边界或multipleOf组合，请提供明确example",
          );
        return validateValue(
          rule.apipostSource
            ? generateNative(rule.expression, schema)
            : generate(rule.expression, schema),
          schema,
        );
      }
    return undefined;
  };
}

export function sampleProjectSchema(project, schema) {
  return sampleFromSchema(
    schema,
    0,
    {
      ...(schema || {}),
      components: project.openapiComponents || schema?.components || {},
    },
    { valueForField: createFieldSampler(project.settings || {}) },
  );
}
export function schemaMockResponse(project, request) {
  for (const definition of request.responses || []) {
    if (!/^2\d\d$/.test(String(definition.status))) continue;
    let schema, contentType;
    if (definition.schema !== undefined) {
      schema = definition.schema;
      contentType = definition.contentType || "application/json";
    } else {
      const hasSchema = (media) => media.schema !== undefined;
      if (
        !responseMediaEntries(definition.content).some(([, media]) =>
          hasSchema(media),
        )
      )
        continue;
      const selected = selectJsonResponseMedia(definition.content, hasSchema);
      if (selected) [contentType, { schema }] = selected;
    }
    if (!isJsonResponseType(contentType))
      throw Error("自动Schema Mock仅支持JSON响应，请提供显式响应示例");
    return {
      status: Number(definition.status),
      body: JSON.stringify(sampleProjectSchema(project, schema)),
      headers: { "content-type": contentType },
      delayMs: 0,
    };
  }
  return {
    status: 200,
    body: "{}",
    headers: { "content-type": "application/json" },
    delayMs: 0,
  };
}
