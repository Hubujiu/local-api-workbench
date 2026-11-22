import assert from "node:assert/strict";
import test from "node:test";
import { hasVisibleTrash } from "../public/empty-trash.js";

test("empty overlay is scoped to the existing visible request and project restore surfaces", () => {
  const active = { requests: [{ id: "r" }] };
  assert.equal(hasVisibleTrash(active, [{ id: "p" }]), false);
  assert.equal(
    hasVisibleTrash({ requests: [{ deletedAt: "past" }] }, []),
    true,
  );
  assert.equal(
    hasVisibleTrash(active, [{ id: "other", archived: true }]),
    true,
  );
  assert.equal(
    hasVisibleTrash(
      {
        ...active,
        apiResourceTrash: {
          batches: [{ documents: ["not listed in existing UI"] }],
        },
      },
      [],
    ),
    false,
  );
});
