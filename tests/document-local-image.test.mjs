import test from "node:test";
import assert from "node:assert/strict";
import {
  documentImageMime,
  documentImagePatch,
  readLocalDocumentImage,
} from "../public/document-local-image.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
  "base64",
);

test("content inspection chooses the real image type and full browser decode is mandatory", async () => {
  const disguised = new File([png], "irrelevant.jpg", { type: "image/jpeg" });
  let closed = 0;
  const uri = await readLocalDocumentImage(disguised, async (blob) => {
    assert.equal(blob.type, "image/png");
    assert.deepEqual(
      new Uint8Array(await blob.arrayBuffer()),
      new Uint8Array(png),
    );
    return {
      close() {
        closed++;
      },
    };
  });
  assert.match(uri, /^data:image\/png;base64,/);
  assert.equal(closed, 1);
  assert.equal(
    documentImageMime(Uint8Array.of(255, 216, 255), ""),
    "image/jpeg",
  );
  await assert.rejects(
    readLocalDocumentImage(disguised, async () => {
      throw Error("bad bits");
    }),
    /无法解码/,
  );
  await assert.rejects(
    readLocalDocumentImage(
      new File(["not a PNG"], "bad.png", { type: "image/png" }),
    ),
    /PNG文件头无效/,
  );
  await assert.rejects(
    readLocalDocumentImage(
      new File(["<svg></svg>"], "bad.svg", { type: "image/svg+xml" }),
    ),
    /仅支持PNG\/JPEG/,
  );
});

test("large byte and dimension guards fail before decoding and insertions preserve all existing source", async () => {
  await assert.rejects(
    readLocalDocumentImage({
      size: 128 * 1024 + 1,
      arrayBuffer() {
        assert.fail("read oversized file");
      },
    }),
    /128KiB/,
  );
  const huge = Buffer.from(png);
  huge.writeUInt32BE(4097, 16);
  await assert.rejects(
    readLocalDocumentImage(new File([huge], "large.png"), () =>
      assert.fail("decoded out-of-bound file"),
    ),
    /尺寸/,
  );
  const source = "prefix selected suffix";
  const end = source.indexOf(" suffix");
  const uri = "data:image/png;base64," + png.toString("base64");
  const inserted =
    source.slice(0, end) +
    documentImagePatch(source, end, uri) +
    source.slice(end);
  assert.equal(inserted, "prefix selected\n\n![图片](" + uri + ")\n\n suffix");
  assert.throws(
    () => documentImagePatch("x".repeat(256 * 1024), 4, uri),
    /256KiB/,
  );
});
