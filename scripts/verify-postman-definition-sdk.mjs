// Optional isolated development oracle, not part of CI or production dependencies.
// Argument must be an explicitly installed official postman-collection@5.3.1
// package directory. Do not run against untrusted code or user projects.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { normalizeRequest } from "../src/core.mjs";
import { exportPostmanDefinition } from "../src/postman-definition-export.mjs";
const packageRoot = process.argv[2];
if (!packageRoot || !path.isAbsolute(packageRoot) || process.argv.length !== 3)
  throw Error("Provide an absolute isolated official SDK package directory");
const metadata = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
assert.equal(metadata.name, "postman-collection");
assert.equal(metadata.version, "5.3.1");
const sdk = createRequire(import.meta.url)(packageRoot);
const p = {
  name: "Synthetic isolated SDK oracle",
  folders: ["Accounts"],
  requests: [
    normalizeRequest({
      name: "Read",
      folder: "Accounts",
      url: "https://example.invalid/static?token=literal",
      bodyType: "none",
    }),
    normalizeRequest({
      name: "Create",
      description: "Definition description",
      folder: "Accounts",
      method: "POST",
      url: "https://example.invalid/create",
      bodyType: "raw",
      body: '{"literal":"{{who}}"}',
      headers: [
        { key: "Content-Type", value: "application/json", enabled: true },
        { key: "Authorization", value: "Bearer synthetic", enabled: true },
      ],
    }),
  ],
};
const output = exportPostmanDefinition(p);
const collection = new sdk.Collection(output);
const items = [];
collection.forEachItem((item) => items.push(item));
assert.deepEqual(
  items.map((item) => item.name),
  ["Read", "Create"],
);
for (const [i, item] of items.entries()) {
  assert.equal(item.request.url.toString(), p.requests[i].url);
  assert.equal(item.request.method, p.requests[i].method);
}
assert.equal(items[1].request.body.raw, p.requests[1].body);
assert.equal(items[1].request.headers.get("Authorization"), "Bearer synthetic");
assert.equal(items[1].request.description.content, "Definition description");
const again = new sdk.Collection(collection.toJSON());
assert.equal(
  again.items.all()[0].items.all()[1].request.body.raw,
  p.requests[1].body,
);
console.log(
  "Official isolated postman-collection 5.3.1 oracle passed; no runtime execution or dynamic-variable evaluation",
);
