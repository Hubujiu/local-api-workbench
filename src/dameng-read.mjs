import { compileDamengRead } from "./dameng-read-contract.mjs";
import { databaseRows } from "./database-values.mjs";
export const DAMENG_READ_DRIVER_STATUS = Object.freeze({
  available: false,
  package: "dmdb",
  version: "1.0.52452",
  reason: "redistribution-and-peer-authentication-unverified",
});
const fail = () => {
  throw Error("DAMENG_READ_FAILED_NO_RESULT");
};
const check = (signal) => {
  if (signal?.aborted) throw Error("DAMENG_READ_CANCELLED");
};
export async function runDamengRead(input, { factory, signal } = {}) {
  check(signal);
  const plan = compileDamengRead(input);
  if (typeof factory !== "function")
    throw Error("DAMENG_VERIFIED_TRANSPORT_UNAVAILABLE");
  let port;
  try {
    port = factory(plan.config);
  } catch {
    fail();
  }
  if (
    !port ||
    typeof port.connect !== "function" ||
    typeof port.readOnly !== "function" ||
    typeof port.query !== "function" ||
    typeof port.destroy !== "function" ||
    typeof port.closed?.then !== "function"
  )
    fail();
  const closure = Promise.resolve(port.closed).then(
    () => true,
    () => false,
  );
  let result,
    failed = false,
    stopped = false;
  const destroy = () => {
    if (!stopped) {
      stopped = true;
      port.destroy();
    }
  };
  const stop = () => {
    try {
      destroy();
    } catch {
      failed = true;
    }
  };
  signal?.addEventListener("abort", stop, { once: true });
  const phase = async (fn) => {
    check(signal);
    let timer, rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = () => reject(Error("DAMENG_READ_CANCELLED"));
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
            stop();
            reject(Error("DAMENG_READ_TIMEOUT"));
          }, 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", rejectAbort);
    }
  };
  try {
    const peer = await phase(() => port.connect());
    check(signal);
    if (
      peer?.host !== plan.config.host ||
      peer?.port !== plan.config.port ||
      peer?.serverName !== plan.config.serverName ||
      peer?.certificateVerified !== true ||
      !["TLSv1.2", "TLSv1.3"].includes(peer?.protocol)
    )
      fail();
    if ((await phase(() => port.readOnly())) !== true) fail();
    check(signal);
    const columns = [],
      rows = [];
    let bytes = 100,
      metadata = false,
      receiving = true;
    try {
      await phase(() =>
        port.query(
          { sql: plan.sql, binds: plan.binds },
          {
            metadata(fields) {
              if (!receiving) return;
              check(signal);
              if (
                metadata ||
                !Array.isArray(fields) ||
                fields.length !== plan.columns.length
              )
                fail();
              for (let i = 0; i < fields.length; i++) {
                const f = fields[i];
                if (
                  f.name !== plan.columns[i] ||
                  !["text", "decimal", "int64", "binary"].includes(f.type)
                )
                  fail();
                columns.push({ name: f.name, type: f.type });
              }
              bytes += Buffer.byteLength(JSON.stringify(columns));
              metadata = true;
            },
            row(values) {
              if (!receiving) return;
              check(signal);
              if (
                !metadata ||
                !Array.isArray(values) ||
                values.length !== columns.length ||
                rows.length >= 1000
              )
                fail();
              for (let i = 0; i < values.length; i++) {
                const v = values[i];
                if (v === null) continue;
                if (columns[i].type === "binary") {
                  if (!Buffer.isBuffer(v)) fail();
                } else {
                  if (typeof v !== "string" || !v.isWellFormed()) fail();
                  if (
                    columns[i].type === "int64" &&
                    (!/^-?(0|[1-9]\d{0,18})$/.test(v) ||
                      BigInt(v) < -(1n << 63n) ||
                      BigInt(v) >= 1n << 63n)
                  )
                    fail();
                  if (
                    columns[i].type === "decimal" &&
                    (v.length > 41 ||
                      !/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v) ||
                      v.replace(/^-?0?\.?/, "").replace(".", "").length > 38)
                  )
                    fail();
                }
              }
              bytes += Buffer.byteLength(JSON.stringify(values));
              if (bytes > 1024 * 1024) fail();
              rows.push(
                values.map((v) => (Buffer.isBuffer(v) ? Buffer.from(v) : v)),
              );
            },
          },
        ),
      );
      check(signal);
      if (!metadata) fail();
      result = databaseRows(
        columns.map((c) => c.name),
        rows,
      );
    } finally {
      receiving = false;
    }
  } catch {
    failed = true;
  } finally {
    signal?.removeEventListener("abort", stop);
    try {
      destroy();
    } catch {
      failed = true;
    }
    if (!(await closure)) failed = true;
  }
  check(signal);
  if (failed) fail();
  return result;
}
