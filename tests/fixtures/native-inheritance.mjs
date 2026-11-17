import { modernApipostFixture } from "./apipost-modern.mjs";
export function nativeInheritanceFixture() {
  const d = modernApipostFixture();
  d.global.marks = [];
  delete d.apis[1].mark_id;
  d.apis[1].response = { example: [] };
  d.global.global_param.auth = {
    type: "bearer",
    bearer: { key: "{{token}}" },
    basic: { username: "inactive", password: "must-not-retain" },
  };
  d.global.global_param.header.parameter = [
    { key: "X-Shared", value: "project", is_checked: 1 },
  ];
  d.apis[0].request.header = {
    parameter: [{ key: "X-Folder", value: "folder", is_checked: 1 }],
  };
  d.apis[1].request.header.parameter = [
    { key: "X-Shared", value: "disabled-child", is_checked: -1 },
  ];
  return d;
}
