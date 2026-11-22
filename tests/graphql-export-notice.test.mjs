import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphqlExportNoticeHTML } from "../public/graphql-export-notice.js";
import { prepareGraphQLNamedQueryChange } from "../public/graphql-named-queries.js";
import { createApp } from "../src/server.mjs";
import { importDocument } from "../src/core.mjs";
import {
  activeBody,
  inactiveBody,
  namedGraphQLExportFixture,
} from "./helpers/graphql-export-scope-fixture.mjs";

test("strictly contextual notice does not interpolate any request data", () => {
  const fixture = namedGraphQLExportFixture();
  assert.equal(graphqlExportNoticeHTML({ requests: [] }), "");
  for (const request of [
    { ...fixture, deletedAt: "2026-11-22T00:00:00Z" },
    { ...fixture, graphqlEditorVersion: undefined },
    { ...fixture, graphqlNamedQueries: { items: [{ id: "single" }] } },
  ])
    assert.equal(graphqlExportNoticeHTML({ requests: [request] }), "");
  const rendered = graphqlExportNoticeHTML({ requests: [fixture] });
  assert.match(rendered, /当前活动查询/);
  assert.match(rendered, /无法精确表示的数字/);
  assert.match(rendered, /本地项目 JSON/);
  assert.match(rendered, /role="status" hidden/);
  assert.doesNotMatch(
    rendered,
    /9007199|ActiveFixture|InactiveFixture|localhost|127\.0\.0/,
  );
});

test("real OpenAPI exchange is lossy but a local project backup survives restore and reopen with both exact queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-graphql-export-"));
  let app;
  try {
    app = await createApp({ root, port: 0 });
    const fixture = namedGraphQLExportFixture();
    const project = await app.store.create("Synthetic precision boundary");
    project.requests = [fixture];
    const before = await app.store.save(project);
    const path = "/api/projects/" + project.id;
    const request = async (url, status, data) => {
      const res = await fetch(app.url + url, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      assert.equal(res.status, status);
      return res.text();
    };
    const exchanged = await request(path + "/export?format=openapi", 200);
    const archive = await request(path + "/export?format=native", 200);
    assert(exchanged.includes("ActiveFixture"));
    assert(!exchanged.includes("InactiveFixture"));
    assert(exchanged.includes('"exact":9007199254740992'));
    assert(!exchanged.includes("9007199254740993"));
    const document = JSON.parse(exchanged);
    const example =
      document.paths["/graphql"].post.requestBody.content["application/json"]
        .example;
    assert.equal(Object.is(example.variables.minus, -0), false);
    assert.equal(example.variables.literal, "A");
    const [reimported] = importDocument(document);
    assert.equal(reimported.bodyType, "json");
    assert.equal(Object.hasOwn(reimported, "graphqlNamedQueries"), false);
    assert.equal(Object.hasOwn(reimported, "graphqlEditorVersion"), false);
    assert.match(reimported.body, /9007199254740992/);
    assert.doesNotMatch(reimported.body, /InactiveFixture|9007199254740993/);

    const native = JSON.parse(archive);
    assert.equal(native.requests[0].body, activeBody);
    assert.equal(
      native.requests[0].graphqlNamedQueries.items[0].body,
      inactiveBody,
    );
    const restored = JSON.parse(
      await request("/api/restore", 201, { document: native }),
    );
    assert.notEqual(restored.id, project.id);
    const reopened = JSON.parse(
      await request("/api/projects/" + restored.id, 200),
    );
    const copy = reopened.requests[0];
    assert.equal(copy.body, activeBody);
    assert.equal(copy.graphqlEditorVersion, 1);
    assert.deepEqual(copy.graphqlNamedQueries, fixture.graphqlNamedQueries);
    assert.equal(
      Object.hasOwn(copy.graphqlNamedQueries.items[1], "body"),
      false,
    );
    const switchToInactive = prepareGraphQLNamedQueryChange(copy, {
      type: "select",
      id: "default",
    });
    assert.equal(switchToInactive.body, inactiveBody);
    assert.equal(
      switchToInactive.graphqlNamedQueries.items[1].body,
      activeBody,
    );
    assert.deepEqual(await app.store.get(project.id), before);
    const complete = JSON.parse(
      await request(
        "/api/projects/" + restored.id + "/export?format=native",
        200,
      ),
    );
    assert.deepEqual(await app.store.get(restored.id), complete);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
