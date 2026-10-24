import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { trackedQuickJS } from "./tracked-quickjs.mjs";
const zero = new Set([
  "cfirst",
  "clast",
  "first",
  "last",
  "protocol",
  "tld",
  "ip",
  "region",
  "province",
  "zip",
  "hex",
  "rgb",
  "rgba",
  "hsl",
]);
const flags = new Set(["name", "cname", "city", "county"]);
const strings = new Set(["email", "domain", "url", "color"]);
const colors = new Set([
  "navy",
  "blue",
  "aqua",
  "teal",
  "olive",
  "green",
  "lime",
  "yellow",
  "orange",
  "red",
  "maroon",
  "fuchsia",
  "purple",
  "silver",
  "gray",
  "black",
  "white",
]);
export function parseNativeMockLibrary(value) {
  if (typeof value !== "string") return null;
  const match = /^@([A-Za-z]+)(?:\(([\s\S]*)\))?$/.exec(value);
  if (!match || ![zero, flags, strings].some((set) => set.has(match[1])))
    return null;
  if (Buffer.byteLength(value) > 1024) throw Error("原版库Mock表达式最多1KiB");
  let args;
  try {
    args = JSON.parse("[" + (match[2] || "") + "]");
  } catch {
    throw Error("原版库Mock参数必须是JSON字面量");
  }
  const name = match[1];
  if (
    (zero.has(name) && args.length) ||
    (flags.has(name) &&
      (args.length > 1 || args.some((x) => typeof x !== "boolean")))
  )
    throw Error("原版库Mock参数不支持");
  if (
    strings.has(name) &&
    (args.length > (name === "url" ? 2 : 1) ||
      args.some(
        (x) =>
          typeof x !== "string" ||
          !x ||
          Buffer.byteLength(x) > 256 ||
          x.includes("@") ||
          /[\u0000-\u001f\u007f]/.test(x),
      ))
  )
    throw Error("原版库Mock仅支持有界字面字符串参数，不支持嵌套表达式");
  if (name === "color" && args.length && !colors.has(args[0]))
    throw Error("原版颜色名称不支持");
  return { name, args };
}
const [code, manifestText] = await Promise.all([
  readFile(new URL("./vendor/native-mock-library.js", import.meta.url), "utf8"),
  readFile(
    new URL("./vendor/native-mock-library.json", import.meta.url),
    "utf8",
  ),
]);
const manifest = JSON.parse(manifestText);
if (
  manifest.package !== "apipost-mock" ||
  manifest.version !== "1.0.2" ||
  createHash("sha256").update(code).digest("hex") !== manifest.sha256
)
  throw Error("原版Mock库完整性校验失败");
const { engine } = await trackedQuickJS();
export function createNativeMockEvaluator(random) {
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  let deadline = Date.now() + 1000,
    remaining = 250,
    calls = 0,
    disposed = false;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      vm.dispose();
      runtime.dispose();
    }
  };
  const read = (result) => {
    if (result.error) {
      const error = vm.dump(result.error);
      result.error.dispose();
      throw Error(
        "原版Mock库执行失败：" +
          String(error?.message || "未知错误").slice(0, 200),
      );
    }
    const value = result.value;
    return value;
  };
  try {
    const rng = vm.newFunction("__nativeRandom", () => {
      const n = random();
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n >= 1)
        return { error: vm.newError("Mock随机值无效") };
      return vm.newNumber(n);
    });
    vm.setProp(vm.global, "__nativeRandom", rng);
    rng.dispose();
    read(
      vm.evalCode(
        "Math.random=__nativeRandom;" + code,
        "native-mock-library.js",
      ),
    ).dispose();
    return {
      evaluate(spec) {
        if (disposed) throw Error("原版Mock运行上下文已关闭");
        const checked = parseNativeMockLibrary(
          "@" + spec.name + "(" + JSON.stringify(spec.args).slice(1, -1) + ")",
        );
        if (!checked) throw Error("原版Mock库函数不支持");
        if (++calls > 1000 || remaining <= 0)
          throw Error("原版Mock库运行额度已用尽");
        deadline = Date.now() + remaining;
        const start = performance.now();
        let handle;
        try {
          handle = read(
            vm.evalCode(
              "JSON.stringify(__nativeMockRandom[" +
                JSON.stringify(checked.name) +
                "](..." +
                JSON.stringify(checked.args) +
                "))",
            ),
          );
          const text = vm.getString(handle);
          if (Buffer.byteLength(text) > 65536)
            throw Error("原版Mock库结果超过64KiB");
          const value = JSON.parse(text);
          if (typeof value !== "string") throw Error("原版Mock库结果类型不符");
          return value;
        } finally {
          remaining -= performance.now() - start;
          handle?.dispose();
        }
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
export function evaluateNativeMock(spec, random) {
  const scope = createNativeMockEvaluator(random);
  try {
    return scope.evaluate(spec);
  } finally {
    scope.dispose();
  }
}
