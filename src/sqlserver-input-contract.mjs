// Experimental inert adapter: no driver import, execution, grant or provider.
import { types } from "node:util";
import { sqlServerConnectionContract } from "./sqlserver-driver-contract.mjs";
import { compileSQLServerRead } from "./sqlserver-read-contract.mjs";

const connectionFields = [
  "host",
  "port",
  "user",
  "password",
  "database",
  "ca",
  "ssl",
];
const fields = new Set(["type", "sql", "parameters", ...connectionFields]);
const invalid = () => Error("SQL Server input contract: invalid read input");
const check = (signal) => {
  if (signal?.aborted)
    throw Object.assign(Error("SQL Server input contract: cancelled"), {
      name: "AbortError",
    });
};

// Returns a compiled candidate only. It grants no authority and must not be
// accepted as a public execution token. Default port is undefined -> 1433 only.
export async function prepareSQLServerReadInput(input, { signal } = {}) {
  check(signal);
  let config, compilation;
  try {
    if (
      !input ||
      types.isProxy(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    )
      throw invalid();
    const values = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        typeof key !== "string" ||
        !fields.has(key) ||
        !Object.hasOwn(descriptor, "value")
      )
        throw invalid();
      values[key] = descriptor.value;
    }
    if (values.type !== "sqlserver") throw invalid();
    const connection = {};
    for (const key of connectionFields)
      if (Object.hasOwn(values, key)) connection[key] = values[key];
    config = sqlServerConnectionContract(connection);
    // Compiler synchronously snapshots parameters before starting its worker.
    compilation = compileSQLServerRead(values.sql, values.parameters);
    const plan = await compilation;
    check(signal);
    return { config, plan };
  } catch {
    check(signal);
    // Never publish driver/compiler text, input values or cancellation reasons.
    throw invalid();
  }
}
