import test from "node:test";
import assert from "node:assert/strict";
import { readArchiveOwnerResponse } from "./helpers/archive-owner-response.mjs";

test("archive owner success parses once without cloning or reading text", async () => {
  const expected = { archive: { retained: [1, 2, 3] } };
  let reads = 0;
  const result = await readArchiveOwnerResponse({
    ok: true,
    clone() {
      assert.fail("successful archive must not be cloned");
    },
    text() {
      assert.fail("successful archive must not be decoded as text");
    },
    async json() {
      reads++;
      return expected;
    },
  });
  assert.equal(result, expected);
  assert.equal(reads, 1);
});

test("archive owner failure retains the exact assertion and unread original body", async () => {
  for (const body of ["", "synthetic failure: 中文\nsecond line"]) {
    const response = new Response(body, { status: 409 });
    let original;
    try {
      assert(response.ok, await response.clone().text());
    } catch (error) {
      original = error;
    }
    await assert.rejects(readArchiveOwnerResponse(response), (error) => {
      for (const key of [
        "name",
        "code",
        "message",
        "actual",
        "expected",
        "operator",
      ]) {
        assert.equal(error[key], original[key], key);
      }
      return true;
    });
    assert.equal(response.bodyUsed, false);
    assert.equal(await response.text(), body);
  }
});

test("archive owner success retains JSON decoding failures", async () => {
  const response = new Response("not JSON", { status: 200 });
  await assert.rejects(readArchiveOwnerResponse(response), SyntaxError);
  assert.equal(response.bodyUsed, true);
});

test("archive owner failure retains diagnostic read failures before JSON", async () => {
  const failure = new Error("synthetic diagnostic read failure");
  const response = {
    ok: false,
    clone() {
      return {
        async text() {
          throw failure;
        },
      };
    },
    json() {
      assert.fail("failed response must not be parsed as JSON");
    },
  };
  await assert.rejects(
    readArchiveOwnerResponse(response),
    (error) => error === failure,
  );
});
