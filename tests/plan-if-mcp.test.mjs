import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { readMCPActivities } from "../src/mcp-activity.mjs";

const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const literal = (value) => ({ literal: value });
const gate = (left, right, steps) => ({
  id: "gate",
  type: "if",
  condition: { left, op: "eq", right },
  steps,
});
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "plan-if-mcp-"));
  const app = await createApp({ root, port: 0 });
  const clients = [],
    seen = [];
  const peer = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"private":"owned-secret-marker-not-a-real-secret"}');
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    app.server.closeAllConnections();
    peer.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => app.server.close(resolve)),
      new Promise((resolve) => peer.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const allowed = await app.store.create("IF SDK allowed");
  const denied = await app.store.create("IF SDK denied");
  denied.globalVariables = { foreignOnly: 1 };
  await app.store.save(denied);
  const owner = async (route, body, method = "POST") => {
    const response = await fetch(app.url + "/api/" + route, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  const configure = async (options = {}) => {
    const response = await owner("mcp/config", {
      enabled: true,
      projects: [allowed.id],
      write: true,
      execute: true,
      remember: false,
      ...options,
    });
    assert.equal(response.status, 200, JSON.stringify(response.value));
    return response.value;
  };
  const connect = async (transport = "http", options = {}) => {
    const client = new Client({
      name: "canonical-if-fixture",
      version: "1.0.0",
    });
    clients.push(client);
    if (transport === "http") {
      const config = await configure(options);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + config.token } },
        }),
        { timeout: 5000 },
      );
    } else {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            path.resolve(import.meta.dirname, "../src/mcp.mjs"),
            "--project",
            allowed.id,
            "--write",
            "--execute",
          ],
          env: { ...process.env, LOCAL_API_DATA: root },
          stderr: "pipe",
        }),
        { timeout: 5000 },
      );
    }
    return client;
  };
  const call = (client, name, args) =>
    client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
  const leaf = (id, target = "/must-not-run") => ({
    id,
    request: {
      name: id,
      method: "GET",
      url: `http://127.0.0.1:${peer.address().port}${target}`,
    },
  });
  const save = async (client, id, steps) =>
    decode(
      await call(client, "localapi_save_plan", {
        projectId: allowed.id,
        plan: {
          id,
          name: id,
          environmentId: allowed.environments[0].id,
          steps,
        },
      }),
    );
  const activity = async (planId) => {
    const config = await owner("mcp/config", undefined, "GET");
    assert.equal(config.status, 200);
    const found = config.value.activities.find(
      (entry) =>
        entry.tool === "localapi_run_plan" &&
        entry.projectId === allowed.id &&
        entry.planId === planId,
    );
    assert.ok(found, JSON.stringify(config.value.activities));
    return found;
  };
  return {
    root,
    app,
    allowed,
    denied,
    seen,
    owner,
    connect,
    call,
    leaf,
    save,
    activity,
  };
}

function checkFalse(run) {
  assert.equal(run.status, "passed");
  assert.equal(run.recordSaved, true, JSON.stringify(run.persistenceError));
  assert.equal(run.recordId, run.id);
  assert.deepEqual(run.results, []);
  assert.equal(run.conditionResults.length, 1);
  assert.equal(run.conditionResults[0].groupId, "gate");
  assert.equal(run.conditionResults[0].matched, false);
}
function checkFinalProgress(activity, { completed, total, status }) {
  assert.equal(activity.status, status);
  assert.equal(activity.completed, completed);
  assert.equal(activity.total, total);
  assert.equal(activity.totalIsPotential, true);
  assert.equal(activity.finished, true);
  assert.equal(activity.conditions, 1);
}

test(
  "official SDK HTTP and stdio save and finish false-only IF without fabricated HTTP progress or borrowed project grants",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const sdk = await f.connect();
    const plan = await f.save(sdk, "same-plan-id", [
      gate(literal(false), literal(true), [f.leaf("child")]),
    ]);
    const otherPlan = await f.owner(`projects/${f.denied.id}/plans`, {
      id: plan.id,
      name: "denied same identity",
      environmentId: f.denied.environments[0].id,
      steps: [
        gate(literal(true), literal(true), [
          f.leaf("foreign-child", "/must-not-borrow"),
        ]),
      ],
    });
    assert.equal(otherPlan.status, 200);
    const deniedBefore = await f.app.store.get(f.denied.id);
    for (const name of ["localapi_run_plan", "localapi_get_execution_flow"])
      assert.equal(
        (await f.call(sdk, name, { projectId: f.denied.id, planId: plan.id }))
          .isError,
        true,
      );
    assert.equal(
      (
        await f.call(sdk, "localapi_save_plan", {
          projectId: f.denied.id,
          plan,
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await f.call(sdk, "localapi_execute_flow", {
          projectId: f.allowed.id,
          planId: plan.id,
          environmentId: f.denied.environments[0].id,
        })
      ).isError,
      true,
    );
    assert.deepEqual(f.seen, []);
    assert.deepEqual(await f.app.store.get(f.denied.id), deniedBefore);

    const run = decode(
      await f.call(sdk, "localapi_run_plan", {
        projectId: f.allowed.id,
        planId: plan.id,
      }),
    );
    checkFalse(run);
    checkFinalProgress(await f.activity(plan.id), {
      completed: 0,
      total: 1,
      status: "completed",
    });
    assert.deepEqual(f.seen, []);
    const detail = decode(
      await f.call(sdk, "localapi_get_execution_result", {
        projectId: f.allowed.id,
        runId: run.id,
      }),
    );
    assert.deepEqual(detail.conditionResults, run.conditionResults);
    assert.deepEqual(detail.snapshot.steps, plan.steps);

    const stdio = await f.connect("stdio");
    const stdioRun = decode(
      await f.call(stdio, "localapi_run_plan", {
        projectId: f.allowed.id,
        planId: plan.id,
      }),
    );
    checkFalse(stdioRun);
    await stdio.close();
    const progress = (await readMCPActivities(f.root)).find(
      (entry) => entry.planId === plan.id && entry.source === "stdio",
    );
    assert.ok(progress);
    checkFinalProgress(progress, {
      completed: 0,
      total: 1,
      status: "completed",
    });
    assert.equal(progress.executionStatus, "passed");
    assert.equal(Object.hasOwn(progress, "stepStatus"), false);
    assert.equal(stdioRun.planHash, run.planHash);
    assert.deepEqual(f.seen, []);

    const readonly = await f.connect("http", { write: false, execute: false });
    const tools = (await readonly.listTools(undefined, { timeout: 5000 }))
      .tools;
    assert.equal(
      tools.some((tool) =>
        [
          "localapi_run_plan",
          "localapi_save_plan",
          "localapi_execute_flow",
        ].includes(tool.name),
      ),
      false,
    );
    const beforeReadonly = await f.app.store.get(f.allowed.id);
    for (const [name, args] of [
      ["localapi_run_plan", { projectId: f.allowed.id, planId: plan.id }],
      ["localapi_save_plan", { projectId: f.allowed.id, plan }],
    ])
      assert.equal((await f.call(readonly, name, args)).isError, true);
    assert.deepEqual(
      decode(
        await f.call(readonly, "localapi_get_execution_result", {
          projectId: f.allowed.id,
          runId: run.id,
        }),
      ).conditionResults,
      run.conditionResults,
    );
    assert.equal(
      (
        await f.call(readonly, "localapi_get_execution_result", {
          projectId: f.denied.id,
          runId: run.id,
        })
      ).isError,
      true,
    );
    assert.deepEqual(await f.app.store.get(f.allowed.id), beforeReadonly);
    assert.deepEqual(await f.app.store.get(f.denied.id), deniedBefore);
    assert.deepEqual(f.seen, []);
  },
);

test(
  "canonical SDK summaries distinguish failed IF decisions from HTTP failures and preserve the last successful leaf activity",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const sdk = await f.connect();
    const deniedBefore = await f.app.store.get(f.denied.id);
    for (const withEarlierHTTP of [false, true]) {
      const plan = await f.save(sdk, "missing-condition-" + withEarlierHTTP, [
        ...(withEarlierHTTP ? [f.leaf("earlier", "/earlier-effect")] : []),
        gate({ scope: "globals", name: "foreignOnly" }, literal(1), [
          f.leaf("child"),
        ]),
        f.leaf("later", "/must-not-run-after-failure"),
      ]);
      const run = decode(
        await f.call(sdk, "localapi_run_plan", {
          projectId: f.allowed.id,
          planId: plan.id,
        }),
      );
      assert.equal(run.status, "failed");
      assert.equal(run.stopReason, "condition-error");
      assert.equal(run.recordSaved, true, JSON.stringify(run.persistenceError));
      assert.equal(run.results.length, withEarlierHTTP ? 1 : 0);
      assert.equal(run.conditionResults.length, 1);
      assert.equal(run.conditionResults[0].code, "PLAN_CONDITION_INVALID");
      assert.equal(Object.hasOwn(run.conditionResults[0], "matched"), false);
      const failed = [
        {
          stepId: "gate",
          groupId: "gate",
          occurrenceId: run.conditionResults[0].occurrenceId,
          status: "failed",
          code: "PLAN_CONDITION_INVALID",
        },
      ];
      const summaries = decode(
        await f.call(sdk, "localapi_list_execution_runs", {
          projectId: f.allowed.id,
          scope: "flow",
          source: "mcp",
          status: "failed",
          planId: plan.id,
        }),
      );
      assert.equal(summaries.length, 1);
      const summary = summaries[0];
      assert.equal(summary.id, run.id);
      assert.equal(summary.status, "failed");
      assert.equal(summary.stopReason, "condition-error");
      assert.equal(summary.failedStepCount, 0);
      assert.deepEqual(summary.failedSteps, []);
      assert.equal(summary.conditionCount, 1);
      assert.equal(summary.failedConditionCount, 1);
      assert.deepEqual(summary.failedConditions, failed);
      for (const key of [
        "conditionResults",
        "snapshot",
        "results",
        "request",
        "response",
        "variables",
        "error",
      ])
        assert.equal(Object.hasOwn(summary, key), false);
      assert.equal(
        JSON.stringify(summary).includes("owned-secret-marker"),
        false,
      );
      const catalogue = decode(
        await f.call(sdk, "localapi_list_plans", { projectId: f.allowed.id }),
      );
      const listed = catalogue.runs.find((item) => item.id === run.id);
      assert.equal(listed.stopReason, "condition-error");
      assert.equal(listed.conditionCount, 1);
      assert.equal(listed.failedConditionCount, 1);
      assert.deepEqual(listed.failedConditions, failed);
      assert.equal(Object.hasOwn(listed, "conditionResults"), false);
      const detail = decode(
        await f.call(sdk, "localapi_get_execution_result", {
          projectId: f.allowed.id,
          runId: run.id,
        }),
      );
      assert.deepEqual(detail.conditionResults, run.conditionResults);
      assert.deepEqual(detail.results, run.results);
      const activity = await f.activity(plan.id);
      checkFinalProgress(activity, {
        completed: withEarlierHTTP ? 1 : 0,
        total: withEarlierHTTP ? 3 : 2,
        status: "failed",
      });
      assert.equal(activity.executionStatus, "failed");
      if (withEarlierHTTP) {
        assert.equal(activity.stepId, "earlier");
        assert.equal(activity.stepStatus, "passed");
        assert.equal(run.results[0].status, "passed");
      } else assert.equal(Object.hasOwn(activity, "stepStatus"), false);
    }
    const stdio = await f.connect("stdio");
    const stdioRun = decode(
      await f.call(stdio, "localapi_run_plan", {
        projectId: f.allowed.id,
        planId: "missing-condition-true",
      }),
    );
    assert.equal(stdioRun.status, "failed");
    assert.equal(stdioRun.stopReason, "condition-error");
    assert.equal(stdioRun.recordSaved, true);
    assert.equal(stdioRun.results.length, 1);
    assert.equal(stdioRun.results[0].status, "passed");
    await stdio.close();
    const stdioActivity = (await readMCPActivities(f.root)).find(
      (entry) =>
        entry.planId === "missing-condition-true" && entry.source === "stdio",
    );
    assert.ok(stdioActivity);
    checkFinalProgress(stdioActivity, {
      completed: 1,
      total: 3,
      status: "failed",
    });
    assert.equal(stdioActivity.executionStatus, "failed");
    assert.equal(stdioActivity.stepId, "earlier");
    assert.equal(stdioActivity.stepStatus, "passed");
    assert.deepEqual(f.seen, ["/earlier-effect", "/earlier-effect"]);
    assert.deepEqual(await f.app.store.get(f.denied.id), deniedBefore);
  },
);

test(
  "native SDK result and history views reject retained IF decisions even when the historical snapshot is absent",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const sdk = await f.connect();
    const record = {
      id: "retained-condition-only-history",
      planId: "removed-plan",
      planName: "historical IF",
      status: "failed",
      source: "manual",
      createdAt: "2026-01-02T03:04:05.000Z",
      durationMs: 1,
      results: [],
      stopReason: "condition-error",
      conditionResults: [
        {
          stepId: "gate",
          groupId: "gate",
          occurrenceId: "historical-gate",
          status: "failed",
          code: "PLAN_CONDITION_INVALID",
        },
      ],
    };
    const project = await f.app.store.get(f.allowed.id);
    project.runs = [record];
    await f.app.store.save(project, { activity: true });
    const before = await f.app.store.get(f.allowed.id);
    assert.equal(Object.hasOwn(before.runs[0], "snapshot"), false);
    const canonical = decode(
      await f.call(sdk, "localapi_get_execution_result", {
        projectId: f.allowed.id,
        runId: record.id,
      }),
    );
    assert.deepEqual(canonical, record);
    for (const [name, args] of [
      [
        "apipost_get_execution_result",
        { project_id: f.allowed.id, run_id: record.id },
      ],
      ["apipost_list_execution_runs", { project_id: f.allowed.id }],
    ]) {
      const result = await f.call(sdk, name, args);
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.match(result.content[0].text, /条件组/);
    }
    assert.deepEqual(await f.app.store.get(f.allowed.id), before);
    assert.deepEqual(f.seen, []);
  },
);

test(
  "final IF failure progress retains the prior nested repeat leaf identity on official SDK HTTP and stdio",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const sdk = await f.connect();
    const plan = await f.save(sdk, "nested-repeat-condition-failure", [
      {
        id: "outer",
        type: "repeat",
        count: 2,
        steps: [
          {
            id: "inner",
            type: "repeat",
            count: 2,
            steps: [
              f.leaf("earlier", "/nested-earlier-effect"),
              gate({ scope: "runtime", name: "never-set" }, literal(1), [
                f.leaf("child"),
              ]),
            ],
          },
        ],
      },
      f.leaf("tail"),
    ]);
    const expectedRepeat = {
      groupId: "inner",
      childId: "earlier",
      iteration: 0,
      occurrenceId: '[[["outer",0],["inner",0]],"earlier"]',
      path: [
        { groupId: "outer", iteration: 0 },
        { groupId: "inner", iteration: 0 },
      ],
    };
    const expectedDecisionId = '["if",[["outer",0],["inner",0]],"gate"]';
    let firstHash;
    for (const transport of ["http", "stdio"]) {
      const client = transport === "http" ? sdk : await f.connect("stdio");
      const run = decode(
        await f.call(client, "localapi_run_plan", {
          projectId: f.allowed.id,
          planId: plan.id,
        }),
      );
      assert.equal(run.status, "failed");
      assert.equal(run.stopReason, "condition-error");
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, 1);
      assert.equal(run.results[0].status, "passed");
      assert.deepEqual(run.results[0].repeat, expectedRepeat);
      assert.equal(run.conditionResults.length, 1);
      assert.equal(run.conditionResults[0].occurrenceId, expectedDecisionId);
      assert.notEqual(
        run.conditionResults[0].occurrenceId,
        expectedRepeat.occurrenceId,
      );
      firstHash ??= run.planHash;
      assert.equal(run.planHash, firstHash);
      let activity;
      if (transport === "http") activity = await f.activity(plan.id);
      else {
        await client.close();
        activity = (await readMCPActivities(f.root)).find(
          (entry) => entry.planId === plan.id && entry.source === "stdio",
        );
      }
      assert.ok(activity);
      checkFinalProgress(activity, {
        completed: 1,
        total: 9,
        status: "failed",
      });
      assert.equal(activity.executionStatus, "failed");
      assert.equal(activity.stepId, "earlier");
      assert.equal(activity.stepStatus, "passed");
      assert.deepEqual(activity.repeat, expectedRepeat);
    }
    assert.deepEqual(f.seen, [
      "/nested-earlier-effect",
      "/nested-earlier-effect",
    ]);
    const disk = await f.app.store.get(f.allowed.id);
    assert.equal(disk.runs.length, 2);
    assert.ok(
      disk.runs.every(
        (run) => run.conditionResults[0].occurrenceId === expectedDecisionId,
      ),
    );
    assert.deepEqual(disk.plans[0].steps, plan.steps);
    assert.deepEqual((await f.app.store.get(f.denied.id)).runs, []);
  },
);
