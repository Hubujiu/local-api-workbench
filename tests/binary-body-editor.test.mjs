import test from "node:test";
import assert from "node:assert/strict";
import {
  binaryBodyHTML,
  prepareBinaryBodyChange,
  readBinaryBodyFile,
} from "../public/binary-body-editor.js";

test("a binary boundary plans clearing without mutating shared body or metadata", () => {
  const body = "bG9jYWw=";
  for (const [from, to] of [
    ["binary", "json"],
    ["binary", "msgpack"],
    ["binary", "none"],
    ["binary", "form-data"],
    ["binary", "urlencoded"],
    ["json", "binary"],
    ["msgpack", "binary"],
    ["none", "binary"],
  ]) {
    const owner = { bodyType: from, body, schema: { type: "object" } };
    const before = structuredClone(owner);
    assert.deepEqual(prepareBinaryBodyChange(owner, to), {
      clear: true,
      nextType: to,
    });
    assert.deepEqual(owner, before);
  }
  assert.deepEqual(
    prepareBinaryBodyChange({ bodyType: "binary", body: "" }, "raw"),
    {
      clear: false,
      nextType: "raw",
    },
  );
  assert.equal(
    prepareBinaryBodyChange({ bodyType: "raw", body }, "json"),
    null,
  );
});

test("structured/imported metadata blocks reinterpretation and does not leak in the rendered shell", () => {
  for (const metadata of [
    { postmanRawBody: { version: 1, language: "default" } },
    { graphqlVariableTemplate: {} },
    { bodyDynamic: { draft: {} } },
  ]) {
    const body = "bG9jYWw=";
    assert.throws(
      () =>
        prepareBinaryBodyChange(
          { bodyType: "binary", body, ...metadata },
          "raw",
        ),
      /导入或动态模板/,
    );
    assert.throws(
      () =>
        prepareBinaryBodyChange(
          { bodyType: "raw", body, ...metadata },
          "binary",
        ),
      /导入或动态模板/,
    );
    const html = binaryBodyHTML(
      { body, ...metadata },
      { debug: true, icon: () => "" },
    );
    assert.doesNotMatch(html, /type="file"|textarea|bG9jYWw=/);
    assert.match(html, /查看 Base64/);
  }
  const owner = { body: "bG9jYWw=", bodyDynamic: {} };
  const debug = binaryBodyHTML(owner, { debug: true, icon: () => "" });
  assert.match(debug, /type="file"/);
  assert.match(debug, /已载入二进制请求体/);
  assert.doesNotMatch(debug, /textarea|bG9jYWw=/);
  assert.doesNotMatch(
    binaryBodyHTML(owner, { debug: false }),
    /type="file"|bG9jYWw=/,
  );
});

test("only owned nonempty bounded file bytes become Base64", async () => {
  const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
  const file = new File([bytes], "synthetic.bin");
  assert.equal(
    await readBinaryBodyFile(file, () => true),
    Buffer.from(bytes).toString("base64"),
  );
  assert.equal(await readBinaryBodyFile(file, () => false), undefined);
  assert.equal(await readBinaryBodyFile(undefined, () => true), undefined);
  await assert.rejects(
    readBinaryBodyFile({ size: 0 }, () => true),
    /选择非空文件/,
  );
  await assert.rejects(
    readBinaryBodyFile({ size: 6 * 1024 * 1024 + 1 }, () => true),
    /6 MiB/,
  );
  await assert.rejects(
    readBinaryBodyFile(
      {
        size: 1,
        arrayBuffer: async () => new ArrayBuffer(6 * 1024 * 1024 + 1),
      },
      () => true,
    ),
    /6 MiB/,
  );
  await assert.rejects(
    readBinaryBodyFile(
      {
        size: 1,
        arrayBuffer: () => {
          throw Error("private detail");
        },
      },
      () => true,
    ),
    { message: "无法读取选择的文件，请重新选择" },
  );
});

test("late data or late errors lose authority before exposure", async () => {
  for (const rejected of [false, true]) {
    let stale = false;
    let release;
    const pending = new Promise((resolve, reject) => {
      release = () =>
        rejected
          ? reject(Error("private detail"))
          : resolve(new ArrayBuffer(3));
    });
    const result = readBinaryBodyFile(
      { size: 3, arrayBuffer: () => pending },
      () => !stale,
    );
    stale = true;
    release();
    assert.equal(await result, undefined);
  }
});
