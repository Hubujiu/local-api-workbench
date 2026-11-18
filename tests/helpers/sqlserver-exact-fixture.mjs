// Only fixed disposable fixture columns. No row values enter failure diagnostics.
import { queryRemoteDatabase } from "../../src/remote-database.mjs";
const fields = Object.freeze([
  ["exact_amount", "decimal", "9007199254740993.123456789012345678"],
  ["exact_stamp", "datetime2", "2026-11-18T02:03:04.1234567"],
  ["exact_offset", "datetimeoffset", "2026-11-18T02:03:04.1234567+05:30"],
  ["exact_clock", "time", "02:03:04.1234567"],
  ["exact_day", "date", "0001-01-01"],
]);
export async function verifySQLServerExactFixture(
  connection,
  { query = queryRemoteDatabase, onStage = () => {} } = {},
) {
  for (const [column, type, expected] of fields) {
    for (const id of [1, 2]) {
      const label = type + (id === 1 ? "/value" : "/null");
      const stage = (part) => onStage(label + "/" + part);
      const require = (condition) => {
        if (!condition) throw Error("SQLSERVER_EXACT_FIXTURE_ASSERTION_FAILED");
      };
      stage("provider-query");
      let output;
      try {
        output = await query({
          type: "sqlserver",
          ...connection,
          sql: `SELECT ${column} FROM dbo.workbench_sqlserver_gate WHERE id=@p0`,
          parameters: [id],
        });
      } catch {
        // Do not expose provider error text/cause, credentials or partial output.
        throw Error("SQLSERVER_EXACT_FIXTURE_PROVIDER_FAILED");
      }
      stage("result-shape");
      require(output?.truncated === false && output?.limit === 1000);
      require(JSON.stringify(output?.columns) === JSON.stringify([column]));
      require(Array.isArray(output.rows) && output.rows.length === 1);
      require(
        Object.keys(output.rows[0]).length === 1 &&
          Object.hasOwn(output.rows[0], column),
      );
      stage("exact-value");
      require(output.rows[0][column] === (id === 1 ? expected : null));
    }
  }
}
