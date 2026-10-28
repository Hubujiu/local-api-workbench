import { Worker } from "node:worker_threads";
import { isIP } from "node:net";
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const forbidden = new Set([
  "$where",
  "$function",
  "$accumulator",
  "$out",
  "$merge",
  "$eval",
  "$changeStream",
  "__proto__",
  "constructor",
  "prototype",
]);
export function mongoQuery(input) {
  let query = input.query;
  if (query === undefined) {
    if (typeof input.sql !== "string" || Buffer.byteLength(input.sql) > 65536)
      throw Error("MongoDB查询须为至多64KiB的JSON对象");
    try {
      query = JSON.parse(input.sql);
    } catch {
      throw Error("MongoDB查询不是有效JSON");
    }
  }
  if (!object(query)) throw Error("MongoDB查询须为对象");
  for (const key of Object.keys(query))
    if (
      !["collection", "filter", "projection", "sort", "limit", "skip"].includes(
        key,
      )
    )
      throw Error("MongoDB只接受find查询选项");
  if (
    typeof query.collection !== "string" ||
    !query.collection ||
    Buffer.byteLength(query.collection) > 120 ||
    query.collection.includes("\0")
  )
    throw Error("MongoDB集合名称无效");
  const filter = query.filter ?? {},
    projection = query.projection ?? {},
    sort = query.sort ?? {},
    limit = query.limit ?? 1000,
    skip = query.skip ?? 0;
  if (!object(filter) || !object(projection) || !object(sort))
    throw Error("MongoDB筛选/投影/排序须为对象");
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isInteger(skip) ||
    skip < 0 ||
    skip > 100000
  )
    throw Error("MongoDB limit须为1至1000，skip至多100000");
  if (
    Object.values(projection).some((v) => ![0, 1, false, true].includes(v)) ||
    Object.keys(projection).length > 100 ||
    Object.values(sort).some((v) => v !== 1 && v !== -1) ||
    Object.keys(sort).length > 20
  )
    throw Error("MongoDB投影只支持0/1，排序只支持1/-1");
  let nodes = 0;
  const inspect = (value, depth) => {
    if (++nodes > 1000 || depth > 10) throw Error("MongoDB查询结构过大或过深");
    if (value === null || ["string", "boolean"].includes(typeof value)) return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw Error("MongoDB查询数值无效");
      if (Number.isInteger(value) && !Number.isSafeInteger(value))
        throw Error(
          "MongoDB查询裸整数超过安全精度；请用EJSON $numberLong或$numberDecimal字符串表示精确值，近似值请显式使用$numberDouble",
        );
      return;
    }
    if (typeof value !== "object") throw Error("MongoDB查询仅接受JSON值");
    const wrapper = [
      "$numberInt",
      "$numberLong",
      "$numberDouble",
      "$numberDecimal",
    ].find((key) => Object.hasOwn(value, key));
    if (wrapper) {
      const text = value[wrapper];
      if (
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        typeof text !== "string"
      )
        throw Error(`MongoDB ${wrapper}须为独立EJSON包装及字符串`);
      if (wrapper === "$numberInt") {
        if (!/^[+-]?[0-9]+$/.test(text))
          throw Error("MongoDB $numberInt须为有效十进制整数字符串");
        // Bound conversion even for a long string of leading zeros.
        const digits = text.replace(/^[+-]?0*/, "") || "0";
        if (digits.length > 10)
          throw Error(
            "MongoDB $numberInt超出有符号32位整数范围，禁止截断或回绕",
          );
        const integer = BigInt((text.startsWith("-") ? "-" : "") + digits);
        if (integer < -2147483648n || integer > 2147483647n)
          throw Error(
            "MongoDB $numberInt超出有符号32位整数范围，禁止截断或回绕",
          );
      } else if (wrapper === "$numberLong") {
        if (text.length > 20 || !/^(?:\+?0|[+-]?[1-9][0-9]*)$/.test(text))
          throw Error("MongoDB $numberLong须为有效十进制整数字符串");
        const integer = BigInt(text);
        if (integer < -9223372036854775808n || integer > 9223372036854775807n)
          throw Error(
            "MongoDB $numberLong超出有符号64位整数范围，禁止截断或回绕",
          );
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key) || key.includes("\0"))
        throw Error("MongoDB禁止写入/JavaScript/不安全字段");
      inspect(child, depth + 1);
    }
  };
  inspect(query, 0);
  if (Buffer.byteLength(JSON.stringify(query)) > 65536)
    throw Error("MongoDB查询超过64KiB");
  return {
    collection: query.collection,
    filter: structuredClone(filter),
    projection: structuredClone(projection),
    sort: structuredClone(sort),
    limit,
    skip,
  };
}
function databaseName(value) {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 63 ||
    /[\/\\.\s"$\0]/.test(value)
  )
    throw Error("MongoDB数据库/认证库名称无效");
  return value;
}
export function mongoConnection(input) {
  const host = input.host || "127.0.0.1",
    port = Number(input.port) || 27017,
    database = databaseName(input.database);
  if (
    typeof host !== "string" ||
    host.length > 253 ||
    (!isIP(host) && !/^[a-zA-Z0-9.-]+$/.test(host)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw Error("MongoDB主机/端口无效");
  if (input.ssl !== undefined && typeof input.ssl !== "boolean")
    throw Error("MongoDB TLS开关无效");
  for (const key of ["user", "password"])
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" || Buffer.byteLength(input[key]) > 8192)
    )
      throw Error("MongoDB认证参数无效");
  if (
    input.ca !== undefined &&
    (typeof input.ca !== "string" || Buffer.byteLength(input.ca) > 65536)
  )
    throw Error("MongoDB CA无效");
  const options = {
    directConnection: true,
    retryReads: false,
    maxPoolSize: 1,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 3000,
    connectTimeoutMS: 2000,
    socketTimeoutMS: 2000,
    tls: input.ssl === true,
    tlsAllowInvalidCertificates: false,
    tlsAllowInvalidHostnames: false,
    ...(input.ssl && input.ca ? { ca: input.ca } : {}),
    ...(input.user
      ? {
          auth: { username: input.user, password: input.password || "" },
          authSource: databaseName(input.authSource || "admin"),
        }
      : {}),
  };
  return {
    uri:
      "mongodb://" + (isIP(host) === 6 ? "[" + host + "]" : host) + ":" + port,
    database,
    options,
  };
}
export async function executeMongoQuery({ query, connection }) {
  const { MongoClient, BSON } = await import("mongodb");
  const filter = BSON.EJSON.deserialize(query.filter, { relaxed: false });
  const client = new MongoClient(connection.uri, connection.options);
  try {
    await client.connect();
    const cursor = client
      .db(connection.database)
      .collection(query.collection)
      .find(filter, {
        projection: query.projection,
        sort: query.sort,
        skip: query.skip,
        limit: query.limit + 1,
        batchSize: 1,
        maxTimeMS: 2000,
      });
    const rows = [],
      columns = new Set();
    let bytes = 0,
      truncated = false;
    for await (const document of cursor) {
      if (rows.length >= query.limit) {
        truncated = true;
        break;
      }
      if (BSON.calculateObjectSize(document) > 1024 * 1024)
        throw Error("MongoDB单文档超过1MiB，请缩小projection");
      const row = BSON.EJSON.serialize(document, { relaxed: false });
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (bytes > 2 * 1024 * 1024)
        throw Error("MongoDB结果超过2MiB，请缩小limit/projection");
      for (const key of Object.keys(row)) columns.add(key);
      if (columns.size > 1000) throw Error("MongoDB结果字段超过1000项");
      rows.push(row);
    }
    return {
      columns: [...columns],
      rows,
      truncated,
      limit: query.limit,
      format: "extended-json",
    };
  } finally {
    await client.close();
  }
}
export async function queryMongo(input, { signal } = {}) {
  if (signal?.aborted) throw Error("MongoDB查询已取消");
  const query = mongoQuery(input),
    connection = mongoConnection(input);
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./mongodb-worker.mjs", import.meta.url),
      {
        workerData: { query, connection },
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      },
    );
    let settled = false;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      // Do not claim cancellation/completion while its worker still owns sockets.
      try {
        await worker.terminate();
      } catch (terminationError) {
        reject(error || terminationError);
        return;
      }
      error ? reject(error) : resolve(result);
    };
    const cancel = () => finish(Error("MongoDB查询已取消"));
    const timer = setTimeout(
      () => finish(Error("MongoDB查询超过5秒总时限，已终止")),
      5000,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    worker.once("message", (message) =>
      finish(message.error ? Error(message.error) : null, message.result),
    );
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!settled) finish(Error("MongoDB查询进程已退出: " + code));
    });
  });
}
