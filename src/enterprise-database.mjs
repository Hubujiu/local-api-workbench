import { types } from "node:util";
import { compileOracleRead } from "./oracle-read-contract.mjs";
import { queryOracleRead } from "./oracle-read-process.mjs";
import { compileDamengRead } from "./dameng-read-contract.mjs";
import { damengPreviewEnabled, runDamengProcess } from "./dameng-process.mjs";

export function enterpriseCapabilities() {
  return {
    ...(process.env.LOCALAPI_ORACLE_PREVIEW === "read-only" && {
      oracleReadOnlyPreview: true,
    }),
    ...(damengPreviewEnabled() && { damengReadOnlyPreview: true }),
  };
}

export function reviewedRelations(
  values,
  invalid = "数据库授权需要 1 至 16 个唯一的 SCHEMA.TABLE",
) {
  if (
    !Array.isArray(values) ||
    types.isProxy(values) ||
    Object.getPrototypeOf(values) !== Array.prototype ||
    !values.length ||
    values.length > 16 ||
    Reflect.ownKeys(values).length !== values.length + 1
  )
    throw Error(invalid);
  const relations = new Set();
  for (let i = 0; i < values.length; i++) {
    const field = Object.getOwnPropertyDescriptor(values, String(i));
    if (
      typeof field?.value !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,29}\.[A-Za-z_][A-Za-z0-9_]{0,29}$/.test(
        field.value,
      )
    )
      throw Error(invalid);
    relations.add(field.value.toUpperCase());
  }
  if (relations.size !== values.length) throw Error(invalid);
  return [...relations];
}

export function enterpriseConnection(input) {
  const oracle = input.type === "oracle";
  if (
    !(oracle || input.type === "dameng") ||
    !enterpriseCapabilities()[input.type + "ReadOnlyPreview"]
  )
    throw Error("主机未启用此数据库的只读预览");
  const fields = [
    "host",
    "port",
    "user",
    "password",
    "ssl",
    "ca",
    ...(oracle ? ["database", "serverDN"] : ["clientCert", "clientKey"]),
  ];
  const accepted = new Set([
    ...fields,
    "relations",
    "type",
    "name",
    "bindingId",
    "sql",
    "parameters",
  ]);
  if (Object.keys(input).some((key) => !accepted.has(key)))
    throw Error("只读预览的连接字段无效");
  const connection = Object.fromEntries(
    fields.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]),
  );
  if (!oracle) connection.serverName = connection.host;
  const relations = reviewedRelations(input.relations);
  const compile = oracle ? compileOracleRead : compileDamengRead;
  compile({ connection, sql: "SELECT id FROM " + relations[0] });
  return { connection, relations, compile };
}

export async function queryEnterpriseDatabase(input, { signal } = {}) {
  const { connection, relations, compile } = enterpriseConnection(input);
  const read = { connection, sql: input.sql, parameters: input.parameters };
  if (!relations.includes(compile(read).relation))
    throw Error("查询表超出当前连接已核对的授权范围");
  const result = await (input.type === "oracle"
    ? queryOracleRead(read, { signal })
    : runDamengProcess(read, { signal }));
  if (
    signal?.aborted ||
    !enterpriseCapabilities()[input.type + "ReadOnlyPreview"]
  )
    throw Error("数据库查询授权已失效");
  return result;
}
