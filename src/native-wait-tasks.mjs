import { nativeDataArray } from "./native-response-extraction.mjs";

export function normalizeNativeWaitData(value, { enabled = true } = {}) {
  if (enabled) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 1000
    )
      throw Error("启用原生wait仅接受0至1000毫秒的整数，不转换或截断输入");
  } else if (
    !(
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" &&
        value.isWellFormed() &&
        value.length <= 1000)
    )
  ) {
    throw Error("禁用原生wait须保留有界JSON标量，不能省略或执行数据");
  }
  return value;
}
export function compileNativeWaits(values = []) {
  nativeDataArray(values, 16);
  let total = 0;
  const result = values.map((value) => {
    const duration = normalizeNativeWaitData(value);
    if ((total += duration) > 1000)
      throw Error("原生wait每阶段合计最多1000毫秒");
    return duration;
  });
  return result;
}

// Receives the existing raw timer bridge before the public wrappers are created.
// Durations are data; scripts get neither the bridge nor native timer handles.
function installNativeWaits(json, schedule) {
  const parse = JSON.parse,
    P = Promise,
    then = Promise.prototype.then,
    apply = Reflect.apply,
    define = Object.defineProperty,
    Failure = Error;
  const waits = parse(json);
  let consumed = 0,
    completed = 0,
    active = false,
    failed = false;
  return {
    run: (index) => {
      if (failed || active || index !== consumed || index >= waits.length) {
        failed = true;
        throw Failure("原生wait任务次序无效");
      }
      consumed++;
      const duration = waits[index];
      if (duration === 0) {
        completed++;
        return;
      }
      active = true;
      const pending = new P((resolve) => {
        try {
          schedule(() => {
            active = false;
            completed++;
            resolve();
          }, duration);
        } catch (error) {
          active = false;
          failed = true;
          throw error;
        }
      });
      // Await's intrinsic PromiseResolve must not consult a user-replaced
      // prototype constructor/then and resume before the real timer callback.
      define(pending, "constructor", { value: P });
      define(pending, "then", {
        value: (resolve, reject) => apply(then, pending, [resolve, reject]),
      });
      return pending;
    },
    assertComplete: () => {
      if (failed || active || completed !== waits.length)
        throw Failure("原生wait阶段存在未完成的声明任务");
    },
  };
}
export const nativeWaitInstallerSource = installNativeWaits.toString();
