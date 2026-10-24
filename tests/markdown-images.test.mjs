import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/markdown-renderer.mjs";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";
test("offline Markdown embeds bounded PNG images without enabling remote or active images", () => {
  assert.match(
    renderMarkdown(`![pixel](data:image/png;base64,${png})`),
    /<img[^>]+src="data:image\/png/,
  );
  for (const uri of [
    "https://example.test/a.png",
    "file:///tmp/a.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,YmFk",
  ])
    assert.doesNotMatch(renderMarkdown(`![no](${uri})`), /<img/);
});

import { inlineImageURI, validInlineImage } from "../public/inline-image.js";
import { exportDocumentation } from "../public/document-export.js";
import { renderMarkdown as bundled } from "../public/vendor/markdown-renderer.js";
test("inline images enforce byte and pixel ceilings and offline export enables data images only", () => {
  const bytes = Uint8Array.from(Buffer.from(png, "base64"));
  assert.equal(
    inlineImageURI(bytes, "image/png"),
    "data:image/png;base64," + png,
  );
  const huge = bytes.slice();
  new DataView(huge.buffer).setUint32(16, 5000);
  assert.throws(() => inlineImageURI(huge, "image/png"), /尺寸/);
  assert.throws(
    () => inlineImageURI(new Uint8Array(128 * 1024 + 1), "image/png"),
    /128/,
  );
  assert.equal(
    validInlineImage(
      "data:image/png;base64," + Buffer.from(huge).toString("base64"),
    ),
    false,
  );
  const md = `![pixel](data:image/png;base64,${png})`;
  assert.equal(renderMarkdown(md), bundled(md));
  const html = exportDocumentation(
    {
      name: "images",
      requests: [],
      documents: [{ title: "image", content: md }],
      settings: {},
    },
    "html",
  );
  assert.match(html, /img-src data:/);
  assert.match(html, /<img src="data:image/);
  assert.doesNotMatch(
    renderMarkdown(`[link](data:image/png;base64,${png})`),
    /href="data:/,
  );
});

test("Markdown caps aggregate declared image pixels and resets budget per render", () => {
  const b = Uint8Array.from(Buffer.from(png, "base64"));
  const v = new DataView(b.buffer);
  v.setUint32(16, 4000);
  v.setUint32(20, 4000);
  // Header-only mutation tests accounting, not successful image decoding.
  const source = `![large](data:image/png;base64,${Buffer.from(b).toString("base64")})`;
  assert.equal(
    (renderMarkdown(source + "\n\n" + source).match(/<img/g) || []).length,
    1,
  );
  assert.equal((renderMarkdown(source).match(/<img/g) || []).length, 1);
});
