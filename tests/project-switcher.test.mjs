import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesProjectName,
  projectSwitcherHTML,
  selectableProjects,
} from "../public/project-switcher.js";

test("project search shares the same registry projection and only matches visible names", () => {
  const fixture = [
    { id: "a", name: "默认项目" },
    { id: "archive", name: "已经归档", archived: true },
    { id: "broken", name: "缺失文件", error: "private internal path" },
    { id: "b", name: "视觉 fixture", path: "/private/donotsearch" },
  ];
  assert.deepEqual(selectableProjects(fixture), [fixture[0], fixture[3]]);
  assert.equal(matchesProjectName("视觉 fixture", "  FIXTURE "), true);
  assert.equal(matchesProjectName("默认项目", "项目"), true);
  assert.equal(matchesProjectName(fixture[3].name, "donotsearch"), false);
  assert.match(projectSwitcherHTML(true), /aria-expanded="false" disabled/);
  assert.match(projectSwitcherHTML(false), /popover role="dialog"/);
  assert.doesNotMatch(projectSwitcherHTML(false), /disabled/);
});
