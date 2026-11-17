import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { snapshotPlan, runPlan } from "../src/core.mjs";

test("single-level repeat retains literal legacy snapshot serialization and SHA256", async () => {
  // Literal fixture derived from pre-nesting normalization order, not generated
  // by the implementation under test. No endpoint is contacted.
  const expected = (
    await readFile(
      new URL("./fixtures/plan-repeat-legacy-snapshot.json", import.meta.url),
      "utf8",
    )
  ).trim();
  const actual = JSON.stringify(
    snapshotPlan({
      id: "legacy-plan",
      name: "legacy",
      updatedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      steps: [
        {
          type: "repeat",
          id: "group",
          count: 2,
          steps: [
            {
              id: "leaf",
              type: "protocol",
              protocol: {
                definition: {
                  id: "tcp",
                  type: "tcp",
                  url: "localhost",
                  port: 1234,
                },
              },
            },
          ],
        },
      ],
    }),
  );
  assert.equal(actual, expected);
  assert.equal(
    createHash("sha256").update(actual).digest("hex"),
    "dc0fe7361ea1f4e1cd4d1cd161a6cea333313f47420e1c3f8d696dead88fdc37",
  );
});

test("normalization assigns every missing nested group identity once and leaves frozen defaults stable", () => {
  const input = {
    steps: [
      {
        type: "repeat",
        count: 2,
        steps: [
          {
            type: "repeat",
            count: 2,
            steps: [{ request: { url: "https://example.invalid/" } }],
          },
        ],
      },
    ],
  };
  const snapshot = snapshotPlan(input);
  const outer = snapshot.steps[0],
    inner = outer.steps[0],
    leaf = inner.steps[0];
  assert.equal(new Set([outer.id, inner.id, leaf.id]).size, 3);
  for (const group of [outer, inner]) {
    assert.equal(typeof group.id, "string");
    assert.equal(group.enabled, true);
    assert.equal(group.name, "循环组");
  }
  assert.deepEqual(snapshotPlan(snapshot), snapshot);
  assert.equal(input.steps[0].id, undefined);
});

test("nested iterations preserve all scopes and serial before/after script commits", async () => {
  const observed = [],
    commits = [];
  const plan = snapshotPlan({
    steps: [
      {
        type: "repeat",
        id: "outer",
        count: 2,
        steps: [
          {
            type: "repeat",
            id: "inner",
            count: 2,
            steps: [
              {
                id: "leaf",
                request: {
                  url: "https://example.invalid/{{g}}/{{e}}/{{r}}/{{post}}",
                  beforeScript:
                    'pm.globals.set("g", Number(pm.globals.get("g")) + 1); pm.environment.set("e", Number(pm.environment.get("e")) + 1); apt.setVar("r", Number(apt.getVar("r")) + 1);',
                  afterScript:
                    'pm.environment.set("post", Number(pm.environment.get("post")) + 1);',
                },
              },
            ],
          },
        ],
      },
    ],
  });
  const run = await runPlan(
    plan,
    {},
    async (request) => {
      observed.push(request.url);
      return { status: 200, body: "{}", headers: {}, duration: 1 };
    },
    {
      variableScopes: {
        globals: { g: 0 },
        environment: { e: 0, post: 0 },
        runtime: { r: 0 },
      },
      onScopeChanges: async (changes) => {
        commits.push(changes.map(({ name, after }) => [name, after.value]));
      },
    },
  );
  assert.equal(run.status, "passed");
  assert.deepEqual(
    observed,
    [1, 2, 3, 4].map((n) => `https://example.invalid/${n}/${n}/${n}/${n - 1}`),
  );
  assert.deepEqual(
    commits,
    [1, 2, 3, 4].flatMap((n) => [
      [
        ["g", n],
        ["e", n],
      ],
      [["post", n]],
    ]),
  );
  assert.equal(run.variables.g, 4);
  assert.equal(run.variables.e, 4);
  assert.equal(run.variables.r, 4);
  assert.equal(run.variables.post, 4);
});
