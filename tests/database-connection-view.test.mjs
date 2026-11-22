import assert from "node:assert/strict";
import test from "node:test";
import { databaseConnectionHTML } from "../public/database-connection-view.js";

test("layout keeps actual database controls, sibling labels and actions disjoint", () => {
  const html = databaseConnectionHTML();
  const connection = html.slice(
    0,
    html.indexOf('class="database-query-section"'),
  );
  for (const field of [
    "type",
    "host",
    "port",
    "user",
    "password",
    "name",
    "auth-source",
    "tls",
    "ca",
    "client-cert",
    "client-key",
    "server-dn",
    "relations",
    "path",
    "sql",
    "params",
  ]) {
    assert.match(
      html,
      new RegExp(
        '<label for="db-' +
          field +
          '">[^<]*</label><(?:select|input|textarea) id="db-' +
          field +
          '"',
      ),
    );
    assert.equal(
      [...html.matchAll(new RegExp('id="db-' + field + '"', "g"))].length,
      1,
    );
  }
  assert.match(connection, /<option value="sqlite">SQLite<\/option>/);
  assert.match(
    connection,
    /<input id="db-password" type="password" autocomplete="off">/,
  );
  assert.doesNotMatch(
    connection,
    /id="db-query"|id="db-register"|测试连接|连接名称|role="dialog"/,
  );
  for (const id of ["db-query", "db-register", "db-connections"])
    assert.match(html, new RegExp('<button type="button" id="' + id + '"'));
});
