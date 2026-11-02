// Builtin-only adapter. The licensed generator is supplied privately by the
// trusted bundle; tests may supply an inert generator without loading Mock/VM.
export function createScriptMockFacade(generate, reserve) {
  const globals = globalThis,
    objectPrototype = Object.prototype,
    arrayPrototype = Array.prototype,
    apply = Reflect.apply,
    ownKeys = Reflect.ownKeys,
    descriptor = Object.getOwnPropertyDescriptor,
    prototype = Object.getPrototypeOf,
    define = Object.defineProperty,
    create = Object.create,
    freeze = Object.freeze,
    same = Object.is,
    array = Array.isArray,
    finite = Number.isFinite,
    safe = Number.isSafeInteger,
    number = Number,
    text = String,
    charCode = String.prototype.charCodeAt,
    includes = String.prototype.includes,
    regexpExec = RegExp.prototype.exec,
    has = Object.prototype.hasOwnProperty,
    weakHas = WeakSet.prototype.has,
    weakAdd = WeakSet.prototype.add,
    Weak = WeakSet,
    Failure = Error;
  const call = (fn, self, args) => apply(fn, self, args);
  const owns = (value, key) => call(has, value, [key]);
  const defineData = (target, key, value, enumerable = true) => {
    const property = create(null);
    property.value = value;
    property.enumerable = enumerable;
    property.writable = true;
    property.configurable = true;
    define(target, key, property);
    return target;
  };
  const fail = (message) => {
    throw new Failure("Mock模板: " + message);
  };
  const limitBytes = 65536,
    limitNodes = 1000,
    limitDepth = 32;
  const dangerous = (key) =>
    key === "__proto__" || key === "prototype" || key === "constructor";
  const rulePattern =
    /^([^|\u0000-\u001f\u007f\u2028\u2029]+)\|(-?[1-9]\d*|0)(?:-(-?[1-9]\d*|0))?$/;

  // Snapshot the complete reachable intrinsic graph, including function
  // objects (e.g. an own toString.call), symbols and prototype chains. Never
  // restore monkeypatched globals: refuse before calling the ambient vendor.
  const names = [
    "Object",
    "Array",
    "String",
    "RegExp",
    "Function",
    "Number",
    "Boolean",
    "Math",
    "JSON",
    "Reflect",
    "Symbol",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "WeakSet",
    "Error",
  ];
  const globalDescriptors = [],
    records = [],
    seenIntrinsics = new Weak();
  const fields = [
    "value",
    "get",
    "set",
    "writable",
    "enumerable",
    "configurable",
  ];
  const copyDescriptor = (source) => {
    const result = create(null);
    for (let i = 0; i < fields.length; i++) {
      const key = fields[i];
      if (owns(source, key)) result[key] = source[key];
    }
    return result;
  };
  const snapshot = (value) => {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    )
      return;
    if (call(weakHas, seenIntrinsics, [value])) return;
    call(weakAdd, seenIntrinsics, [value]);
    const keys = ownKeys(value),
      descriptions = [],
      parent = prototype(value);
    records[records.length] = { value, keys, descriptions, parent };
    snapshot(parent);
    for (let i = 0; i < keys.length; i++) {
      const description = copyDescriptor(descriptor(value, keys[i]));
      descriptions[i] = description;
      for (let j = 0; j < 3; j++) {
        const field = fields[j];
        if (owns(description, field)) snapshot(description[field]);
      }
    }
  };
  for (let i = 0; i < names.length; i++) {
    const description = copyDescriptor(descriptor(globals, names[i]));
    globalDescriptors[i] = description;
    snapshot(description.value);
  }
  const equalDescriptor = (actual, expected) => {
    if (!actual) return false;
    for (let i = 0; i < fields.length; i++) {
      const key = fields[i];
      if (
        owns(actual, key) !== owns(expected, key) ||
        (owns(expected, key) && !same(actual[key], expected[key]))
      )
        return false;
    }
    return true;
  };
  const guard = () => {
    for (let i = 0; i < names.length; i++)
      if (!equalDescriptor(descriptor(globals, names[i]), globalDescriptors[i]))
        fail("内建对象已修改");
    for (let i = 0; i < records.length; i++) {
      const record = records[i],
        keys = ownKeys(record.value);
      if (
        prototype(record.value) !== record.parent ||
        keys.length !== record.keys.length
      )
        fail("内建对象已修改");
      for (let j = 0; j < keys.length; j++)
        if (
          keys[j] !== record.keys[j] ||
          !equalDescriptor(
            descriptor(record.value, keys[j]),
            record.descriptions[j],
          )
        )
          fail("内建对象已修改");
    }
  };

  // Exact JSON UTF-8 byte length without JSON.stringify/getters/toJSON.
  const stringBytes = (value) => {
    if (value.length > limitBytes) fail("输入或展开结果超过64KiB");
    let bytes = 2;
    for (let i = 0; i < value.length; i++) {
      const code = call(charCode, value, [i]);
      if (
        code === 34 ||
        code === 92 ||
        code === 8 ||
        code === 9 ||
        code === 10 ||
        code === 12 ||
        code === 13
      )
        bytes += 2;
      else if (code < 32) bytes += 6;
      else if (code < 128) bytes++;
      else if (code < 2048) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = i + 1 < value.length ? call(charCode, value, [i + 1]) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          i++;
        } else bytes += 6;
      } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
      else bytes += 3;
      if (bytes > limitBytes) fail("输入或展开结果超过64KiB");
    }
    return bytes;
  };
  const add = (a, b, cap) => {
    if (a > cap - b) fail("输入或展开额度超限");
    return a + b;
  };
  const multiply = (a, b, cap) => {
    if (b !== 0 && a > cap / b) fail("输入或展开额度超限");
    return a * b;
  };
  const parseKey = (key, allowRules) => {
    if (dangerous(key)) fail("禁止原型属性");
    if (!call(includes, key, ["|"])) return { name: key, rule: null };
    if (!allowRules) fail("结果包含未投影规则");
    const match = call(regexpExec, rulePattern, [key]);
    if (!match) fail("不支持的键规则");
    const min = number(match[2]),
      max = match[3] === undefined ? min : number(match[3]);
    if (!safe(min) || !safe(max) || max < min || !safe(max - min))
      fail("整数范围无效");
    if (dangerous(match[1])) fail("禁止原型属性");
    return {
      name: match[1],
      rule: { min, max, pick: min === 1 && match[3] === undefined },
    };
  };
  const inspect = (input, allowRules, clone) => {
    const seen = new Weak();
    let inputNodes = 0,
      inputBytes = 0;
    const chargeInput = (bytes) => {
      inputBytes = add(inputBytes, bytes, limitBytes);
    };
    const walk = (value, rule, depth) => {
      inputNodes = add(inputNodes, 1, limitNodes);
      if (depth > limitDepth) fail("嵌套超过32层");
      const type = typeof value;
      if (
        value === null ||
        type === "boolean" ||
        type === "number" ||
        type === "string"
      ) {
        if (type === "number" && !finite(value)) fail("只支持有限JSON数字");
        if (type === "string" && call(includes, value, ["@"]))
          fail("暂不支持占位符或含@字符串");
        if (rule && type !== "number") fail("仅数字或数组支持键规则");
        const bytes =
          type === "string" ? stringBytes(value) : text(value).length;
        chargeInput(bytes);
        const minBytes = rule ? text(rule.min).length : 0,
          maxBytes = rule ? text(rule.max).length : 0;
        const resultBytes = rule
          ? minBytes > maxBytes
            ? minBytes
            : maxBytes
          : bytes;
        return {
          value,
          nodes: 1,
          bytes: resultBytes,
          workNodes: 1,
          workBytes: resultBytes,
        };
      }
      if (type !== "object") fail("只支持JSON数据树");
      if (call(weakHas, seen, [value])) fail("不支持循环或共享对象别名");
      call(weakAdd, seen, [value]);
      const isArray = array(value),
        parent = prototype(value);
      if (
        parent !== (isArray ? arrayPrototype : objectPrototype) &&
        !(parent === null && !isArray)
      )
        fail("不支持自定义原型");
      if (rule && !isArray) fail("仅数字或数组支持键规则");
      let length = 0;
      if (isArray) {
        const item = descriptor(value, "length");
        if (
          !item ||
          !owns(item, "value") ||
          !safe(item.value) ||
          item.value < 0 ||
          item.value > limitNodes
        )
          fail("数组长度超限");
        length = item.value;
        if (rule && (rule.min < 0 || rule.max > limitNodes))
          fail("数组范围无效");
      }
      const keys = ownKeys(value);
      if (
        keys.length > limitNodes + (isArray ? 1 : 0) ||
        (isArray && keys.length !== length + 1)
      )
        fail("只支持有界稠密JSON数组或对象");
      chargeInput(2);
      const output = clone ? (isArray ? [] : create(null)) : value,
        projected = create(null);
      let nodes = 0,
        bytes = 0,
        workNodes = 0,
        workBytes = 0,
        maxNodes = 0,
        maxBytes = 0,
        members = 0;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (isArray && key === "length") continue;
        if (typeof key !== "string") fail("不支持Symbol属性");
        if (isArray && (key !== text(members) || members >= length))
          fail("只支持稠密JSON数组");
        const item = descriptor(value, key);
        if (!item || !owns(item, "value") || !item.enumerable)
          fail("不支持访问器或隐藏属性");
        const parsed = isArray
          ? { name: key, rule: null }
          : parseKey(key, allowRules);
        if (owns(projected, parsed.name)) fail("规则投影后属性重名");
        defineData(projected, parsed.name, true);
        if (members++) {
          chargeInput(1);
          bytes = add(bytes, 1, limitBytes);
          workBytes = add(workBytes, 1, limitBytes);
        }
        if (!isArray) {
          chargeInput(stringBytes(key) + 1);
          const keyBytes = stringBytes(parsed.name) + 1;
          bytes = add(bytes, keyBytes, limitBytes);
          workBytes = add(workBytes, keyBytes, limitBytes);
        }
        const child = walk(item.value, parsed.rule, depth + 1);
        if (clone) defineData(output, key, child.value);
        nodes = add(nodes, child.nodes, limitNodes);
        bytes = add(bytes, child.bytes, limitBytes);
        workNodes = add(workNodes, child.workNodes, limitNodes);
        workBytes = add(workBytes, child.workBytes, limitBytes);
        if (child.nodes > maxNodes) maxNodes = child.nodes;
        if (child.bytes > maxBytes) maxBytes = child.bytes;
      }
      if (isArray && rule && length) {
        if (rule.pick) {
          // Upstream generates ALL candidates before picking one element.
          return {
            value: output,
            nodes: maxNodes,
            bytes: maxBytes,
            workNodes: add(workNodes, 2, limitNodes),
            workBytes: add(workBytes, 2, limitBytes),
          };
        }
        const count = rule.max;
        // bytes/workBytes include separators inside one full template sequence.
        nodes = multiply(nodes, count, limitNodes);
        workNodes = multiply(workNodes, count, limitNodes);
        bytes = add(
          multiply(bytes, count, limitBytes),
          count > 0 ? count - 1 : 0,
          limitBytes,
        );
        workBytes = add(
          multiply(workBytes, count, limitBytes),
          count > 0 ? count - 1 : 0,
          limitBytes,
        );
      }
      return {
        value: output,
        nodes: add(nodes, 1, limitNodes),
        bytes: add(bytes, 2, limitBytes),
        workNodes: add(workNodes, 1, limitNodes),
        workBytes: add(workBytes, 2, limitBytes),
      };
    };
    return walk(input, null, 0);
  };
  const mock = function (template) {
    // Attempt debit precedes even argument validation. reserve is a private
    // primitive-only host callback, never visible in the public facade.
    reserve(0, 0, 0);
    guard();
    if (new.target) fail("不支持构造调用");
    if (arguments.length !== 1) fail("仅支持单个JSON模板参数");
    const checked = inspect(template, true, true);
    // Proxy traps during traversal may mutate intrinsics. Core receives only
    // the fresh owned clone after this second complete integrity check.
    guard();
    reserve(1, checked.workNodes, checked.workBytes);
    const result = generate(checked.value);
    const actual = inspect(result, false, false);
    if (actual.nodes > checked.nodes || actual.bytes > checked.bytes)
      fail("生成结果超过预检范围");
    // Existing host activity deadline, never a refreshed per-call allowance.
    reserve(2, 0, 0);
    return result;
  };
  return freeze(defineData(create(null), "mock", freeze(mock)));
}
