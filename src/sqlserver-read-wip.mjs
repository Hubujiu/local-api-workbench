// Unregistered WIP: no default factory, no driver import, no public entrypoint.
import {
  compileSQLServerRead,
  sqlServerConnectionContract,
  sqlServerResultTypeAllowed,
} from "./sqlserver-read-contract.mjs";
const abortError = () =>
  Object.assign(Error("SQL Server query cancelled"), { name: "AbortError" });
const check = (signal) => {
  if (signal?.aborted) throw abortError();
};
export const SQLSERVER_READONLY_PROBE =
  "SELECT CONVERT(nvarchar(60), DATABASEPROPERTYEX(DB_NAME(), 'Updateability')) AS [updateability]";
function collector() {
  let metadata,
    bytes = 100,
    truncated = false;
  const rows = [];
  return {
    metadata(columns) {
      if (
        metadata ||
        !Array.isArray(columns) ||
        !columns.length ||
        columns.length > 128
      )
        throw Error("Invalid result metadata");
      const names = new Set();
      metadata = columns.map(({ name, type }) => {
        if (typeof name !== "string" || !name.isWellFormed() || names.has(name))
          throw Error("Invalid or duplicate column name");
        names.add(name);
        sqlServerResultTypeAllowed(type);
        return { name, type };
      });
      bytes += Buffer.byteLength(JSON.stringify(metadata.map((c) => c.name)));
      if (bytes > 1024 * 1024) throw Error("Result exceeds 1MiB");
    },
    row(values) {
      if (
        !metadata ||
        !Array.isArray(values) ||
        values.length !== metadata.length
      )
        throw Error("Invalid result row");
      if (truncated) throw Error("Driver exceeded generated row limit");
      if (rows.length === 1000) {
        truncated = true;
        return;
      }
      const row = Object.create(null);
      for (let i = 0; i < values.length; i++) {
        const value = values[i],
          { name, type } = metadata[i];
        if (value === null) {
          row[name] = null;
          continue;
        }
        if (type === "BigInt") {
          if (
            typeof value !== "string" ||
            !/^-?(0|[1-9]\d{0,18})$/.test(value) ||
            BigInt(value) < -(1n << 63n) ||
            BigInt(value) >= 1n << 63n
          )
            throw Error("Invalid exact bigint");
          row[name] = value;
        } else if (type === "Bit") {
          if (typeof value !== "boolean") throw Error("Invalid bit");
          row[name] = value;
        } else if (["TinyInt", "SmallInt", "Int"].includes(type)) {
          const bounds = {
            TinyInt: [0, 255],
            SmallInt: [-32768, 32767],
            Int: [-2147483648, 2147483647],
          }[type];
          if (
            !Number.isInteger(value) ||
            value < bounds[0] ||
            value > bounds[1]
          )
            throw Error("Invalid integer");
          row[name] = value;
        } else if (["Binary", "VarBinary"].includes(type)) {
          if (!Buffer.isBuffer(value)) throw Error("Invalid binary");
          row[name] = { type: "blob", base64: value.toString("base64") };
        } else {
          if (typeof value !== "string" || !value.isWellFormed())
            throw Error("Invalid text");
          row[name] = value;
        }
      }
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes > 1024 * 1024) throw Error("Result exceeds 1MiB");
      rows.push(row);
    },
    result() {
      if (!metadata) throw Error("Missing result metadata");
      return {
        columns: metadata.map((c) => c.name),
        rows,
        truncated,
        limit: 1000,
      };
    },
  };
}
// Port contract: factory allocates an unconnected owned transport synchronously;
// connect/query promises propagate callback failures; destroy is idempotent and
// closed settles only after real transport closure. Tests use a fake port only.
export async function runSQLServerReadWIP(input, { factory, signal } = {}) {
  check(signal);
  const config = sqlServerConnectionContract(input.connection),
    plan = compileSQLServerRead(input.sql, input.parameters);
  if (typeof factory !== "function")
    throw Error("SQL Server WIP has no installed transport");
  const port = factory(config);
  if (
    !port ||
    typeof port.connect !== "function" ||
    typeof port.query !== "function" ||
    typeof port.destroy !== "function" ||
    !port.closed ||
    typeof port.closed.then !== "function"
  )
    throw Error("Invalid SQL Server WIP transport");
  const closure = Promise.resolve(port.closed).then(
    () => null,
    () => Error("closure failed"),
  );
  let active = true,
    stopped = false;
  const destroy = () => {
    if (!stopped) {
      stopped = true;
      port.destroy();
    }
  };
  const onAbort = () => {
    try {
      destroy();
    } catch {}
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const phase = async (fn, ms) => {
    check(signal);
    let timer, rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = () => reject(abortError());
      signal?.addEventListener("abort", rejectAbort, { once: true });
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          check(signal);
          return fn();
        }),
        aborted,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            try {
              destroy();
            } catch {}
            reject(Error("SQL Server operation timed out"));
          }, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", rejectAbort);
    }
  };
  const query = async (sql, parameters) => {
    const c = collector();
    let receiving = true;
    try {
      await phase(
        () =>
          port.query(
            { sql, parameters },
            {
              metadata: (columns) => {
                if (active && receiving) {
                  check(signal);
                  c.metadata(columns);
                }
              },
              row: (values) => {
                if (active && receiving) {
                  check(signal);
                  c.row(values);
                }
              },
            },
          ),
        2000,
      );
      check(signal);
      return c.result();
    } finally {
      receiving = false;
    }
  };
  let result, error;
  try {
    await phase(() => port.connect(), 3000);
    check(signal);
    const state = await query(SQLSERVER_READONLY_PROBE, []);
    if (
      state.columns.length !== 1 ||
      state.columns[0] !== "updateability" ||
      state.rows.length !== 1 ||
      state.rows[0].updateability !== "READ_ONLY"
    )
      throw Error("Database is not verified READ_ONLY");
    check(signal);
    result = await query(plan.sql, plan.parameters);
    check(signal);
  } catch (e) {
    error = signal?.aborted
      ? abortError()
      : Error("SQL Server WIP read failed; no result published");
  } finally {
    active = false;
    signal?.removeEventListener("abort", onAbort);
    let timer;
    try {
      destroy();
      const closeError = await Promise.race([
        closure,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("closure pending")), 3000);
        }),
      ]);
      if (closeError) throw closeError;
    } catch {
      error = Error(
        "SQL Server transport closure not confirmed; no result published",
      );
    } finally {
      clearTimeout(timer);
    }
  }
  if (error) throw error;
  check(signal);
  return result;
}
