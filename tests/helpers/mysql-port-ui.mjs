import assert from "node:assert/strict";

// Real app DOM/events, with inert responses: this verifies frontend admission,
// not database connectivity or the separate server authorization contract.
export async function exerciseMySQLPortUI(page) {
  return exerciseDatabasePortUI(
    page,
    "mysql",
    "MySQL",
    "3.306e3",
    "0xcea",
    3306,
  );
}
export async function exerciseMongoPortUI(page) {
  return exerciseDatabasePortUI(
    page,
    "mongodb",
    "MongoDB",
    "2.7017e4",
    "0x6989",
    27017,
  );
}
async function exerciseDatabasePortUI(
  page,
  type,
  label,
  exponent,
  hexadecimal,
  samplePort,
) {
  const previous = {
    type: await page.locator("#db-type").inputValue(),
    port: await page.locator("#db-port").inputValue(),
    sql: await page.locator("#db-sql").inputValue(),
    parameters: await page.locator("#db-params").inputValue(),
  };
  const pattern = /\/api\/projects\/[^/]+\/database(?:-connections)?$/;
  const received = [];
  const respond = async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    received.push(route.request().postDataJSON());
    await route.fulfill({
      json: { id: "inert-port-fixture", rows: [{ value: "port-fixture" }] },
    });
  };
  await page.route(pattern, respond);
  await page.evaluate(() => {
    const original = window.fetch;
    window.__databasePortFetchProbe = { original, calls: 0 };
    window.fetch = function (...args) {
      if (
        args[1]?.method === "POST" &&
        /\/api\/projects\/[^/]+\/database(?:-connections)?$/.test(
          new URL(args[0], location.href).pathname,
        )
      )
        window.__databasePortFetchProbe.calls++;
      return Reflect.apply(original, this, args);
    };
  });
  const calls = () =>
    page.evaluate(() => window.__databasePortFetchProbe.calls);
  const submit = async (action) => {
    if (action === "query") {
      await Promise.all([
        page.waitForResponse(
          (response) =>
            pattern.test(new URL(response.url()).pathname) &&
            response.request().method() === "POST",
        ),
        page.locator("#db-query").click(),
      ]);
      await page
        .locator("#db-result")
        .getByText("port-fixture", { exact: false })
        .waitFor();
      await page.waitForFunction(
        () => !document.querySelector("#db-query").disabled,
      );
    } else {
      await page.locator("#db-register").click();
      await page.locator("#db-connection-name").fill("Inert port fixture");
      await Promise.all([
        page.waitForResponse(
          (response) =>
            pattern.test(new URL(response.url()).pathname) &&
            response.request().method() === "POST",
        ),
        page.locator("#dialog-save").click(),
      ]);
      await page.locator("#dialog").waitFor({ state: "hidden" });
    }
  };
  try {
    // MongoDB hides SQL parameters; reset them through the visible MySQL UI.
    await page.locator("#db-type").selectOption("mysql");
    await page.locator("#db-params").fill("[]");
    await page.locator("#db-type").selectOption(type);
    await page.locator("#db-sql").fill("SELECT 1");
    for (const raw of [
      exponent,
      hexadecimal,
      `+${samplePort}`,
      `${samplePort}.0`,
      "abc",
      "Infinity",
      "65536",
      "-1",
    ]) {
      await page.locator("#db-port").fill(raw);
      for (const action of ["query", "register"]) {
        const before = await calls();
        await page.evaluate(() => {
          document.querySelector("#toast").textContent = "";
        });
        await page.locator(`#db-${action}`).click();
        await page
          .locator("#toast")
          .getByText(
            `${label}端口须为十进制整数0至65535；留空或0使用默认端口`,
            {
              exact: true,
            },
          )
          .waitFor();
        assert.equal(await calls(), before, "invalid text must not call fetch");
        assert.equal(await page.locator("#dialog").isVisible(), false);
        assert.equal(await page.locator("#db-query").isEnabled(), true);
        assert.equal(await page.locator("#db-register").isEnabled(), true);
      }
    }
    // Correcting the same controls remains usable, with their old numeric wire type.
    for (const [raw, expected] of [
      ["", 0],
      ["  ", 0],
      ["0", 0],
      ["000", 0],
      [` 0${samplePort} `, samplePort],
      ["65535", 65535],
    ]) {
      await page.locator("#db-port").fill(raw);
      for (const action of ["query", "register"]) {
        await submit(action);
        assert.equal(received.at(-1).type, type);
        assert.equal(received.at(-1).port, expected);
      }
    }
    // Other providers deliberately retain their separate existing conversion.
    for (const type of ["postgres", "redis", "clickhouse"]) {
      await page.locator("#db-type").selectOption(type);
      await page.locator("#db-port").fill("3.306e3");
      for (const action of ["query", "register"]) {
        await submit(action);
        assert.equal(received.at(-1).type, type);
        assert.equal(received.at(-1).port, 3306);
      }
    }
    await page.locator("#db-port").fill("abc");
    await page.locator("#db-type").selectOption("sqlite");
    for (const action of ["query", "register"]) {
      await submit(action);
      assert.equal(received.at(-1).type, "sqlite");
      assert.equal(
        received.at(-1).port,
        null,
        "hidden stale field must not acquire a SQL/Mongo port guard",
      );
    }
  } finally {
    await page.evaluate(() => {
      window.fetch = window.__databasePortFetchProbe.original;
      delete window.__databasePortFetchProbe;
    });
    await page.unroute(pattern, respond);
    await page.locator("#db-type").selectOption(previous.type);
    // Cleanup may restore SQLite, where this field is intentionally hidden.
    await page.locator("#db-port").evaluate((input, value) => {
      input.value = value;
    }, previous.port);
    await page.locator("#db-sql").fill(previous.sql);
    await page.locator("#db-params").evaluate((input, value) => {
      input.value = value;
    }, previous.parameters);
  }
}
