import assert from "node:assert/strict";
import test from "node:test";
import {
  groupRecentHistory,
  matchesRecentHistoryName,
  recentHistoryPage,
} from "../public/recent-history-view.js";

test("local date groups use real timestamps, stable ties and an honest unknown fallback", () => {
  const now = new Date(2026, 10, 21, 13);
  const early = new Date(2026, 10, 21, 11).toISOString();
  const sameDay = { id: "early", createdAt: early };
  const later = {
    id: "late",
    createdAt: new Date(2026, 10, 21, 12).toISOString(),
  };
  const yesterday = {
    id: "previous",
    createdAt: new Date(2026, 10, 20, 12).toISOString(),
  };
  const tie = { id: "tie", createdAt: early };
  const invalid = { id: "invalid", createdAt: "unknown" };
  const groups = groupRecentHistory(
    [sameDay, yesterday, later, tie, invalid],
    now,
  );
  assert.deepEqual(
    groups.map((group) => group.label),
    ["今天", "2026-11-20", "未知日期"],
  );
  assert.deepEqual(
    groups[0].rows.map((row) => row.record.id),
    ["late", "early", "tie"],
  );
  assert.equal(groups[0].rows[1].time.iso, early);
  assert.equal(groups[2].rows[0].time, null);
});

test("timeline names and request fields are text, and absence does not fabricate history", () => {
  assert(matchesRecentHistoryName("Verification", " verification "));
  assert(!matchesRecentHistoryName("Another request", "Verification"));
  const html = recentHistoryPage(
    [
      {
        id: 'entry"unsafe',
        name: "<record>",
        request: { method: "GET", url: "secret-url" },
        response: { status: 201 },
      },
    ],
    { disabled: true },
  );
  assert.match(html, /data-history="entry&quot;unsafe"/);
  assert.match(html, /&lt;record&gt;/);
  assert.match(html, /<span class="success">201<\/span>/);
  assert.match(html, /id="history-project-reload" type="button" disabled/);
  assert.doesNotMatch(html, /secret-url|最近保存|<record>|重放/);
  const empty = recentHistoryPage([]);
  assert.match(empty, /暂无请求历史/);
  assert.doesNotMatch(empty, /data-recent-history-row/);
});
