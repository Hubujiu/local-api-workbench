import test from "node:test";
import { registerLoginScenario } from "./helpers/agent-register-login-fixture.mjs";
for (const failed of [false, true])
  test(
    `official MCP register → returned data → login: failure=${failed}`,
    { timeout: 20000 },
    async (t) => {
      await registerLoginScenario(t, failed);
    },
  );
