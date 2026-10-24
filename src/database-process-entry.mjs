import { querySQLite, mutateSQLite } from "./database.mjs";
// One input, one operation, no retries. Both functions close the database before
// returning. A killed write may have committed; only a delivered result proves it.
process.once("message", (input) => {
  let message;
  try {
    if (!input || !["read", "write"].includes(input.mode))
      throw Error("数据库操作模式无效");
    message = {
      result: (input.mode === "write" ? mutateSQLite : querySQLite)(
        input.filename,
        input.sql,
        input.parameters,
      ),
    };
  } catch (error) {
    message = { error: error.message };
  }
  process.send(message, (error) => {
    if (error) process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
});
