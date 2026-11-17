import test from "node:test";
import assert from "node:assert/strict";
import { exportDocumentation } from "../public/document-export.js";
test("standalone documentation escapes untrusted markup and has no remote assets", () => {
  const project = {
    name: "<script>bad()</script>",
    documents: [],
    requests: [
      {
        name: "one",
        method: "GET",
        url: "http://localhost",
        description: "<img src=x onerror=bad()>",
        bodyType: "none",
        examples: [],
        query: [],
        path: [],
        headers: [],
      },
    ],
  };
  const html = exportDocumentation(project, "html");
  assert(!html.includes("<script>"));
  assert(!html.includes("<img"));
  assert(html.includes("&lt;script&gt;"));
  assert(html.includes("default-src 'none'"));
});
