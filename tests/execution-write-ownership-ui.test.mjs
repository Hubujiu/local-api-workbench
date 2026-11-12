import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProjectImportGuard } from "../public/project-import-guard.js";
import { createNativeRequestLifecycle } from "../public/native-request-lifecycle.js";
import { adoptVariableWrites } from "../public/variable-write-receipt.js";
const source = (
  await readFile(new URL("../public/app.js", import.meta.url), "utf8")
).replaceAll("\r\n", "\n");
const saveSource = source.slice(
  source.indexOf("async function save()"),
  source.indexOf("\nfunction collect()"),
);
const planSource = source.slice(
  source.indexOf("async function savePlan("),
  source.indexOf("\nfunction editRules("),
);
const helpers = source.includes("function assertExecutionReady(")
  ? source.slice(
      source.indexOf("function assertExecutionReady("),
      source.indexOf("async function savePlan("),
    )
  : "";
const runPlanSource = source.slice(
  source.indexOf('  on("#run-plan",'),
  source.indexOf('  on("[data-export-run]",'),
);
const caseSource = source.slice(
  source.indexOf('  on("[data-run-case]",'),
  source.indexOf('  on(\n    "#load-count'),
);
const openSource = source.slice(
  source.indexOf("async function openProject("),
  source.indexOf("\nfunction modal("),
);
const fixture = () => ({
  id: "a",
  revision: 1,
  configRevision: 1,
  _diskFingerprint: "v1",
  plans: [{ id: "p", name: "old", steps: [] }],
  cases: [
    {
      id: "c",
      name: "case",
      request: { id: "r", url: "http://127.0.0.1:1/never-called" },
    },
  ],
  requests: [{ id: "r", name: "request" }],
  history: [],
  runs: [],
  environments: [],
});
function harness(initial = fixture()) {
  const calls = [],
    guard = createProjectImportGuard(),
    native = createNativeRequestLifecycle();
  const api = (url, method = "GET", body) =>
    new Promise((resolve, reject) =>
      calls.push({ url, method, body, resolve, reject }),
    );
  const create = new Function(
    "initial",
    "api",
    "projectImports",
    "nativeRequestLifecycle",
    "adoptVariableWrites",
    `
 let project=initial,projects=[{id:"a"}],dirty=false,saving=false,busy=false,editVersion=0,projectOpenSequence=0,current="r",planId="p",planTab="plans",lastRun,runId,opened=[],response,loadResult,selectedProtocolId;
 const collect=()=>{},render=()=>{},toast=()=>{},env=()=>project.environments[0]?.id||"e",uid=()=>"run-id",confirm=()=>true;
 const document={querySelectorAll:()=>[]},sessionStorage={setItem(){}},caseResults={set(){}};
 const $=()=>null;const mark=()=>{dirty=true;editVersion++};
 ${saveSource}
 ${helpers}
 ${planSource}
 ${openSource}
 const handlers={};const on=(selector,event,fn)=>{handlers[selector]=fn};
 ${runPlanSource}
 ${caseSource}
 return {ready:assertExecutionReady,runPlan:()=>handlers["#run-plan"](),runCase:()=>handlers["[data-run-case]"](null,{dataset:{runCase:"c"}}),save,savePlan,open:openProject,dirty(){dirty=true},edit(){project.plans[0].name="new draft";mark()},state:()=>({project,dirty,busy,saving,planId,planTab,lastRun}),replace(p){project=p},navigate(){projectOpenSequence++},selectPlan(){planId="other"}};
 `,
  );
  return {
    ...create(initial, api, guard, native, adoptVariableWrites),
    calls,
    guard,
    native,
  };
}
const tick = () => new Promise((r) => setImmediate(r));
test("plan readback never erases edits made during execution", async () => {
  const h = harness(),
    run = h.runPlan();
  await tick();
  h.edit();
  h.calls[0].resolve({ id: "result" });
  await tick();
  h.calls[1].resolve(fixture());
  await assert.rejects(run, /不会自动重放/);
  assert.equal(h.state().project.plans[0].name, "new draft");
});
test("two case clicks while dirty-save is pending execute at most once", async () => {
  const h = harness();
  h.dirty();
  const first = h.runCase(),
    second = h.runCase().catch(() => {});
  await tick();
  assert.equal(
    h.calls.filter((c) => c.url.endsWith("/execute")).length,
    0,
    "no execution before the owning save finishes",
  );
  h.calls[0].resolve(fixture());
  await tick();
  assert.equal(h.calls.filter((c) => c.url.endsWith("/execute")).length, 1);
  h.calls[1].resolve({});
  await tick();
  h.calls[2].resolve(fixture());
  await Promise.all([first, second]);
});
test("known plan execution readback applies when ownership is unchanged", async () => {
  const h = harness(),
    run = h.runPlan();
  await tick();
  h.calls[0].resolve({ id: "result" });
  await tick();
  const saved = { ...fixture(), revision: 2, runs: [{ id: "result" }] };
  h.calls[1].resolve(saved);
  await run;
  assert.equal(h.state().project, saved);
  assert.equal(h.state().planTab, "runs");
  assert.equal(h.state().busy, false);
});
for (const invoke of ["runPlan", "runCase"]) {
  test(`${invoke} lost response cannot replay until explicit safe reload`, async () => {
    const h = harness(),
      run = h[invoke]();
    await tick();
    h.calls[0].reject(Error("timeout"));
    await assert.rejects(run, /不会自动重放/);
    await assert.rejects(h[invoke](), /重新加载/);
    await assert.rejects(h.save(), /重新加载/);
    assert.equal(h.calls.length, 1);
    const reload = h.open("a");
    h.calls[1].resolve(fixture());
    await reload;
    const explicit = h[invoke]();
    await tick();
    assert.equal(h.calls[2].method, "POST");
    h.calls[2].resolve({ id: "new-result" });
    await tick();
    h.calls[3].resolve(fixture());
    await explicit;
  });
  test(`${invoke} successful POST followed by failed GET is not auto-repeated`, async () => {
    const h = harness(),
      run = h[invoke]();
    await tick();
    h.calls[0].resolve({ id: "done" });
    await tick();
    h.calls[1].reject(Error("readback lost"));
    await assert.rejects(run, /不会自动重放/);
    await assert.rejects(h[invoke](), /重新加载/);
    assert.equal(h.calls.filter((c) => c.method === "POST").length, 1);
  });
  test(`${invoke} new draft during owning save causes zero execution`, async () => {
    const h = harness();
    h.dirty();
    const run = h[invoke]();
    await tick();
    h.edit();
    h.calls[0].resolve(fixture());
    await assert.rejects(run, /草稿/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.state().project.plans[0].name, "new draft");
  });
  test(`${invoke} mutation between prepare and POST causes zero execution`, async () => {
    const h = harness(),
      run = h[invoke]();
    h.edit();
    await assert.rejects(run, /草稿/);
    assert.equal(h.calls.length, 0);
    assert.doesNotThrow(h.ready);
  });
}
for (const change of ["edit", "navigate", "replace"]) {
  test(`execution readback preserves ${change} and requires reconciliation`, async () => {
    const h = harness(),
      run = h.runCase();
    await tick();
    h.calls[0].resolve({});
    await tick();
    if (change === "replace") h.replace({ ...fixture(), id: "b" });
    else h[change]();
    const before = h.state().project;
    h.calls[1].resolve(fixture());
    await assert.rejects(run, /不会自动重放/);
    assert.equal(h.state().project, before);
    assert.throws(() => h.guard.assertCanSave("a"), /重新加载/);
  });
}
test("pending write blocks every direct execution admission and imports", async () => {
  const h = harness(),
    op = h.guard.begin("a", "case");
  assert.throws(h.ready, /尚未完成/);
  await assert.rejects(h.runPlan(), /尚未完成/);
  await assert.rejects(h.runCase(), /尚未完成/);
  assert.equal(h.calls.length, 0);
  op.finish();
  for (const marker of [
    "async function send() {",
    "  async function runInterfaceCaseBatch(ids) {",
    '  on("#load-run", "click", async () => {',
    '  on("#protocol-run", "click", async () => {',
  ]) {
    assert(
      source
        .slice(source.indexOf(marker), source.indexOf(marker) + 180)
        .includes("assertExecutionReady();"),
      marker,
    );
  }
});
test("savePlan applies only its owned receipt and retains newer selection", async () => {
  const h = harness(),
    run = h.savePlan({ ...fixture().plans[0], name: "saved" });
  await tick();
  h.selectPlan();
  h.calls[0].resolve({
    id: "p",
    name: "saved",
    steps: [],
    projectRevision: 2,
    projectConfigRevision: 2,
    projectFingerprint: "v2",
  });
  await run;
  assert.equal(h.state().planId, "other");
  assert.equal(h.state().project.plans[0].name, "saved");
  assert.equal(h.state().project.configRevision, 2);
});
test("late plan save cannot overwrite a newer plan edit or adopt stale revision", async () => {
  const h = harness(),
    run = h.savePlan(fixture().plans[0]);
  await tick();
  h.edit();
  h.calls[0].resolve({
    id: "p",
    name: "old",
    steps: [],
    projectRevision: 2,
    projectConfigRevision: 2,
    projectFingerprint: "v2",
  });
  await assert.rejects(run, /不会自动重放/);
  assert.equal(h.state().project.plans[0].name, "new draft");
  assert.equal(h.state().project.configRevision, 1);
  await assert.rejects(h.save(), /重新加载/);
});
test("plan mutations without mark are detected and retained as dirty", async () => {
  const h = harness(),
    run = h.savePlan(fixture().plans[0]);
  await tick();
  h.state().project.plans[0].steps.push({ request: { name: "new" } });
  h.calls[0].resolve({ id: "p", name: "old", steps: [] });
  await assert.rejects(run, /不会自动重放/);
  assert.equal(h.state().dirty, true);
  assert.equal(h.state().project.plans[0].steps.length, 1);
});
test("unknown plan save cannot auto-replay and stale GET cannot unlock it", async () => {
  const h = harness(),
    old = h.open("a"),
    run = h.savePlan(fixture().plans[0]);
  await tick();
  h.calls[1].reject(Error("lost"));
  await assert.rejects(run, /不会自动重放/);
  h.calls[0].resolve(fixture());
  await assert.rejects(old, /状态已变化/);
  await assert.rejects(h.savePlan(fixture().plans[0]), /重新加载/);
  assert.equal(h.calls.filter((c) => c.method === "POST").length, 1);
});
test("four implicit plan handlers return their write promise to the error wrapper", () => {
  for (const selector of [
    "#plan-env",
    "[data-step-enable]",
    "[data-step-up]",
    "[data-step-delete]",
  ]) {
    const start = source.indexOf('  on("' + selector + '"');
    const block = source.slice(start, source.indexOf("\n  });", start));
    assert.match(block, /return savePlan\(p\)/);
  }
});
test("real dirty-save and double case click produce exactly one loopback side effect", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { normalizeRequest } = await import("../src/core.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const http = await import("node:http");
  let hits = 0;
  const target = http.createServer((req, res) => {
    hits++;
    res.end("once");
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(tmpdir(), "execution-ownership-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    await app.close();
    await new Promise((r) => target.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("Execution ownership"),
    request = normalizeRequest({
      id: "r",
      name: "request",
      url: "http://127.0.0.1:" + target.address().port + "/effect",
    });
  p.requests.push(request);
  await app.store.save(p);
  const call = async (url, method = "GET", body) => {
    const response = await fetch(app.url + "/api" + url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert(response.ok, await response.clone().text());
    return response.json();
  };
  const { project } = await call("/projects/" + p.id + "/cases", "POST", {
    id: "c",
    name: "case",
    sourceRequestId: "r",
    request,
  });
  const h = harness(project);
  h.dirty();
  const first = h.runCase(),
    second = h.runCase();
  await assert.rejects(second, /等待|尚未完成/);
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "PUT");
  assert.equal(hits, 0);
  const save = h.calls[0];
  save.resolve(await call(save.url, save.method, save.body));
  await tick();
  const execute = h.calls[1];
  assert(execute.url.endsWith("/execute"));
  execute.resolve(await call(execute.url, execute.method, execute.body));
  await tick();
  const get = h.calls[2];
  get.resolve(await call(get.url));
  await first;
  assert.equal(hits, 1);
  assert.equal(h.calls.filter((c) => c.url.endsWith("/execute")).length, 1);
});
test("unknown native lifecycle result blocks execution even when draft is clean", async () => {
  const h = harness(),
    p = h.state().project;
  p.settings = { nativeInheritance: { folders: [] } };
  p.requests[0].nativeInheritance = {};
  await assert.rejects(
    h.native.run({
      requestId: "r",
      restore: false,
      getState: () => ({ ...h.state(), editVersion: 0 }),
      collect() {},
      confirm: () => true,
      save: h.save,
      post: async () => {
        throw Error("unknown native outcome");
      },
      apply() {
        assert.fail("unknown result cannot apply");
      },
    }),
    /重新加载/,
  );
  assert.equal(h.state().dirty, false);
  assert.throws(h.ready, /重新加载/);
  await assert.rejects(h.runCase(), /重新加载/);
  await assert.rejects(h.runPlan(), /重新加载/);
  assert.equal(h.calls.length, 0);
});
test("actual Ctrl+Enter dispatch catches admission rejection and shows toast", async () => {
  const keyboard = source.slice(
    source.indexOf('document.addEventListener("keydown"'),
    source.indexOf('window.addEventListener("beforeunload"'),
  );
  for (const message of [
    "请等待当前请求或保存结束",
    "执行尚未完成，请等待",
    "请重新加载核对",
  ]) {
    let listener,
      prevented = 0,
      calls = 0;
    const messages = [];
    new Function(
      "document",
      "send",
      "toast",
      `const $=()=>({open:false});let page="apis",busy=false,bodyExpanded=false;const save=()=>Promise.resolve();${keyboard}`,
    )(
      {
        addEventListener: (event, fn) => {
          assert.equal(event, "keydown");
          listener = fn;
        },
      },
      () => {
        calls++;
        return Promise.reject(Error(message));
      },
      (text) => messages.push(text),
    );
    listener({
      ctrlKey: true,
      key: "Enter",
      preventDefault() {
        prevented++;
      },
    });
    await tick();
    assert.equal(calls, 1);
    assert.equal(prevented, 1);
    assert.deepEqual(messages, [message]);
  }
});
test("blocked plan structure callbacks never mutate the current draft before rejection", async () => {
  for (const selector of [
    "#plan-env",
    "[data-step-enable]",
    "[data-step-up]",
    "[data-step-delete]",
    "#plan-status-policy",
    "[data-step-drag]",
  ]) {
    const start = source.indexOf(
      '  on("' +
        selector +
        '"' +
        (selector === "[data-step-drag]" ? ', "drop"' : ""),
    );
    const block = source.slice(start, source.indexOf("\n  });", start) + 6);
    let callback;
    const project = new Proxy(
      {},
      {
        get() {
          assert.fail("blocked callback accessed mutable project");
        },
      },
    );
    new Function("on", "assertExecutionReady", "project", block)(
      (selector, event, fn) => (callback = fn),
      () => {
        throw Error("blocked");
      },
      project,
    );
    await assert.rejects(
      async () =>
        callback(
          { preventDefault() {} },
          { value: "new", dataset: {}, checked: true },
        ),
      /blocked/,
    );
  }
});

test("held real response joins fulfillment before route cleanup", async () => {
  const { holdRealResponse } = await import(
    "./helpers/execution-write-ownership-ui.mjs"
  );
  const held = holdRealResponse();
  let allowFulfill,
    fulfilled = false,
    fetches = 0,
    releases = 0;
  const gate = new Promise((resolve) => {
    allowFulfill = resolve;
  });
  const response = { status: () => 200 };
  const running = held.handler({
    async fetch() {
      fetches++;
      return response;
    },
    async fulfill(options) {
      assert.equal(options.response, response);
      await gate;
      fulfilled = true;
    },
  });
  await held.ready();
  assert.equal(fetches, 1);
  assert.equal(fulfilled, false);
  const releasing = held.release().then(() => {
    releases++;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases, 0, "cannot unroute while fulfillment remains pending");
  allowFulfill();
  await releasing;
  await running;
  await held.release();
  assert.equal(fulfilled, true);
  assert.equal(fetches, 1, "cleanup does not replay the upstream request");
});

test("held response reports fetch and fulfill failures on awaited test path", async () => {
  const { holdRealResponse } = await import(
    "./helpers/execution-write-ownership-ui.mjs"
  );
  for (const phase of ["fetch", "fulfill"]) {
    const held = holdRealResponse(),
      error = Error("fixture " + phase);
    const running = held.handler({
      async fetch() {
        if (phase === "fetch") throw error;
        return { status: () => 200 };
      },
      async fulfill() {
        throw error;
      },
    });
    if (phase === "fetch")
      await assert.rejects(held.ready(), (e) => e === error);
    else await held.ready();
    await assert.rejects(held.release(), (e) => e === error);
    await running; // handler itself never leaks an unhandled rejection
  }
});

test("held response fails unexpected duplicate without replaying upstream", async () => {
  const { holdRealResponse } = await import(
    "./helpers/execution-write-ownership-ui.mjs"
  );
  const held = holdRealResponse();
  let fetches = 0,
    aborts = 0;
  const route = {
    async fetch() {
      fetches++;
      return { status: () => 200 };
    },
    async fulfill() {},
    async abort() {
      aborts++;
    },
  };
  const running = held.handler(route);
  await held.ready();
  await held.handler(route);
  await assert.rejects(held.release(), /unexpected duplicate/);
  await running;
  assert.equal(fetches, 1);
  assert.equal(aborts, 1);
});

test("route cleanup retains original assertion and all cleanup failures", async () => {
  const { finishHeldRoute } = await import(
    "./helpers/execution-write-ownership-ui.mjs"
  );
  const primary = Error("original assertion"),
    release = Error("fulfill failed"),
    remove = Error("unroute failed");
  let removed = false;
  await assert.rejects(
    finishHeldRoute(
      {
        release: async () => {
          throw release;
        },
      },
      async () => {
        removed = true;
        throw remove;
      },
      primary,
    ),
    (e) => {
      assert.ok(e instanceof AggregateError);
      assert.deepEqual(e.errors, [primary, release, remove]);
      return true;
    },
  );
  assert.equal(removed, true);
  await assert.rejects(
    finishHeldRoute({ release: async () => {} }, async () => {}, primary),
    (e) => e === primary,
  );
});

test("response waiter remains observed when held route release fails first", async () => {
  const { releaseWithResponse } = await import(
    "./helpers/execution-write-ownership-ui.mjs"
  );
  const releaseError = Error("release failed"),
    responseError = Error("response timeout");
  let rejectResponse;
  const response = new Promise((_, reject) => {
    rejectResponse = reject;
  });
  await assert.rejects(
    releaseWithResponse(
      {
        release: async () => {
          throw releaseError;
        },
      },
      response,
    ),
    (e) => e === releaseError,
  );
  rejectResponse(responseError);
  await new Promise((resolve) => setImmediate(resolve));
  // node:test fails this test if the now-rejected waiter is unhandled.
});

test("execution browser fixture scopes duplicate plan ids to their owning surface", async () => {
  const fixture = await readFile(
    new URL("./helpers/execution-write-ownership-ui.mjs", import.meta.url),
    "utf8",
  );
  // The hidden creation dialog retains its own #plan-name after close. A bare
  // locator still matches both nodes under Playwright strict mode.
  assert.match(
    fixture,
    /locator\("#dialog #plan-name"\)\.fill\("Owned execution plan"\)/,
  );
  assert.match(
    fixture,
    /locator\("#app #plan-name"\)\s*\.fill\("New plan draft after execution"\)/,
  );
  assert.match(fixture, /locator\("#app #plan-name"\)\.inputValue\(\)/);
  assert.doesNotMatch(fixture, /(?:locator|querySelector)\("#plan-name"\)/);
});
