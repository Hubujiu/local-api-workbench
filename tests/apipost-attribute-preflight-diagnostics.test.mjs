import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import {
  attributeDocument,
  blankAttributeProject,
} from "./fixtures/apipost-export-attributes.mjs";

for (const [format, encode] of [
  ["apipost", exportApipost],
  ["apipost-directory", exportApipostDirectory],
]) {
  for (const kind of [
    "inherited nativeTasks",
    "inherited attributes",
    "attribute getter",
    "hidden attributes",
    "request Proxy",
    "attributes Proxy",
  ]) {
    test(`${format} attribute preflight retains descriptor diagnostics and rejects ${kind} without hooks`, () => {
      const project = blankAttributeProject("source");
      importIntoProject(project, attributeDocument());
      const request = project.requests[0];
      let calls = 0;
      const getter = () => {
        calls++;
        throw Error("untrusted getter executed");
      };
      const traps = Object.fromEntries(
        [
          "get",
          "has",
          "ownKeys",
          "getOwnPropertyDescriptor",
          "getPrototypeOf",
        ].map((key) => [
          key,
          () => {
            calls++;
            throw Error("untrusted Proxy trap executed");
          },
        ]),
      );
      let expected;
      if (kind.startsWith("inherited ")) {
        const key = kind.slice("inherited ".length);
        delete request[key];
        Object.setPrototypeOf(
          request,
          Object.defineProperty({}, key, { enumerable: true, get: getter }),
        );
        expected = /继承属性/;
      } else if (kind === "attribute getter") {
        Object.defineProperty(request, "attributes", {
          enumerable: true,
          configurable: true,
          get: getter,
        });
        expected = /访问器/;
      } else if (kind === "hidden attributes") {
        Object.defineProperty(request, "attributes", { enumerable: false });
        expected = /非数据字段/;
      } else if (kind === "request Proxy") {
        project.requests[0] = new Proxy(request, traps);
        expected = /普通对象原型/;
      } else {
        request.attributes = new Proxy(request.attributes, traps);
        expected = /普通数据对象/;
      }
      const descriptors = Object.getOwnPropertyDescriptors(request),
        prototype = Object.getPrototypeOf(request),
        fields = structuredClone(project.settings.attributes),
        sibling = structuredClone(project.requests[1]);
      assert.throws(() => encode(project), expected);
      assert.equal(calls, 0);
      assert.deepEqual(Object.getOwnPropertyDescriptors(request), descriptors);
      assert.equal(Object.getPrototypeOf(request), prototype);
      assert.deepEqual(project.settings.attributes, fields);
      assert.deepEqual(project.requests[1], sibling);
    });
  }
}
