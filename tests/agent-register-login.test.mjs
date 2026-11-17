import assert from "node:assert/strict";
import test from "node:test";
import { registerLoginScenario } from "./helpers/agent-register-login-fixture.mjs";
for (const failed of [false, true])
  test(
    `official MCP register → returned data → login: failure=${failed}`,
    { timeout: 20000 },
    async (t) => {
      let beforeRunCalled = false;
      await registerLoginScenario(
        t,
        failed,
        async ({ app, project, plan, seen }) => {
          beforeRunCalled = true;
          assert.deepEqual(seen, []);
          const response = await fetch(
            `${app.url}/api/projects/${project.id}`,
            {
              headers: { "x-local-token": app.token },
            },
          );
          assert.equal(response.status, 200);
          const saved = await response.json();
          assert.deepEqual(saved.runs, []);
          assert(saved.plans.some((item) => item.id === plan.id));
        },
      );
      assert.equal(beforeRunCalled, true);
    },
  );
