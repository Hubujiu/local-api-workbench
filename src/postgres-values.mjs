import { types as pgTypes } from "pg";
import postgresArray from "postgres-array";
import { parseDatabaseJSON } from "./database-values.mjs";
export const postgresValueTypes = {
  getTypeParser(oid, format = "text") {
    if (format !== "text") return pgTypes.getTypeParser(oid, format);
    if ([20, 1700, 1082, 1114, 1184].includes(Number(oid))) return (x) => x;
    if ([1016, 1231, 1182, 1115, 1185].includes(Number(oid)))
      return (x) => postgresArray.parse(x);
    if ([114, 3802].includes(Number(oid))) return parseDatabaseJSON;
    if ([199, 3807].includes(Number(oid)))
      return (x) => postgresArray.parse(x, parseDatabaseJSON);
    return pgTypes.getTypeParser(oid, format);
  },
};
