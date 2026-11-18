const answer = {
  type: "dameng-result",
  result: {
    columns: ["V"],
    rows: [{ V: "99999999999999999999999999999999999999" }],
    limit: 1000,
    truncated: false,
  },
};
process.once("message", ({ parameters, connection, sql }) => {
  const [scenario] = parameters;
  if (
    sql !== "SELECT V FROM APP.T WHERE K=:p0" ||
    connection.password !== "synthetic-only" ||
    process.env.HOME !== undefined ||
    process.env.NODE_OPTIONS !== undefined
  )
    process.exit(2);
  if (scenario === "hang") {
    while (true) {}
  }
  if (scenario === "bad-result") answer.result.columns[0] = "WRONG";
  process.send(answer, () => {
    if (scenario === "late-exit") {
      setInterval(() => {}, 100);
      return;
    }
    if (scenario === "second") {
      process.send(answer, () => process.disconnect());
      return;
    }
    if (scenario === "dirty-exit") process.exitCode = 2;
    process.disconnect();
  });
});
