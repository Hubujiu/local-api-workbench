// Inert contract only: no provider, connection, driver or SQL execution.
import { Worker } from "node:worker_threads";
import { types } from "node:util";
const fail = (message) => {
  throw Error(`SQL Server contract: ${message}`);
};
function object(value, keys) {
  if (
    !value ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail("plain data object required");
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !Object.hasOwn(d, "value")
    )
      fail("unknown field or accessor");
    result[key] = d.value;
  }
  return result;
}
function text(value, label, max = 65536) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.includes("\0") ||
    Buffer.byteLength(value) > max
  )
    fail(`invalid ${label}`);
  return value;
}
function parameter(value, index) {
  if (value === null)
    return { name: `p${index}`, type: "NVarChar", value: null };
  if (typeof value === "string")
    return {
      name: `p${index}`,
      type: "NVarChar",
      value: text(value, "parameter"),
    };
  if (typeof value === "boolean")
    return { name: `p${index}`, type: "Bit", value };
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= -2147483648 &&
    value <= 2147483647
  )
    return { name: `p${index}`, type: "Int", value };
  if (value && typeof value === "object") {
    value = object(value, ["type", "value"]);
    if (
      value.type === "int64" &&
      typeof value.value === "string" &&
      /^-?(0|[1-9]\d{0,18})$/.test(value.value)
    ) {
      const n = BigInt(value.value);
      if (n >= -(1n << 63n) && n < 1n << 63n)
        return { name: `p${index}`, type: "BigInt", value: value.value };
    }
  }
  fail("parameter requires null/string/bool/int32 or exact int64");
}

let active = 0;
export async function compileSQLServerRead(sql, values = []) {
  text(sql, "SQL", 8192);
  if (
    types.isProxy(values) ||
    !Array.isArray(values) ||
    Object.getPrototypeOf(values) !== Array.prototype
  )
    fail("plain parameter array required");
  const length = Object.getOwnPropertyDescriptor(values, "length").value;
  if (length > 64 || Reflect.ownKeys(values).length !== length + 1)
    fail("parameter budget or sparse array");
  const parameters = [];
  let bytes = 0;
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(values, String(i));
    if (!d || !Object.hasOwn(d, "value"))
      fail("dense data parameters required");
    const p = parameter(d.value, i);
    bytes += Buffer.byteLength(JSON.stringify(p));
    if (bytes > 1024 * 1024) fail("parameters exceed 1MiB");
    parameters.push(p);
  }
  if (active >= 2) fail("compiler busy");
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("./sqlserver-read-contract-worker.mjs", import.meta.url),
        {
          workerData: { sql, parameters },
          execArgv: [],
          resourceLimits: {
            maxOldGenerationSizeMb: 32,
            maxYoungGenerationSizeMb: 8,
            stackSizeMb: 2,
          },
        },
      );
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker
          .terminate()
          .then(() => (error ? reject(error) : resolve(result)), reject);
      };
      const timer = setTimeout(
        () =>
          finish(Error("SQL Server contract: compilation deadline exceeded")),
        2000,
      );
      worker.once("message", (m) =>
        finish(m.error ? Error(m.error) : null, m.result),
      );
      worker.once("error", () =>
        finish(Error("SQL Server contract: compiler failed")),
      );
      worker.once("exit", () =>
        finish(Error("SQL Server contract: compiler exited")),
      );
    });
  } finally {
    active--;
  }
}
