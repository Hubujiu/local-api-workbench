export const oracleInput = () => ({
  connection: {
    host: "fixture.invalid",
    database: "FREEPDB1",
    user: "fixture",
    password: "private-secret",
    ssl: true,
    serverDN: "CN=fixture.invalid",
  },
  sql: "SELECT id, amount FROM fixture.items WHERE id=:p0",
  parameters: [1],
});
