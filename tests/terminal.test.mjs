import test from "node:test";
import assert from "node:assert/strict";
import { terminalLaunch } from "../desktop/terminal.mjs";
test("terminal launch never inserts project paths into command source", () => {
  const directory = "C:\\project & unexpected ' text";
  const windows = terminalLaunch(directory, "win32");
  assert(!windows.args.join(" ").includes(directory));
  assert.equal(windows.options.env.LOCAL_API_DIRECTORY, directory);
  assert.equal(windows.options.cwd, directory);
  const linux = terminalLaunch("/tmp/a b", "linux");
  assert.equal(linux.args.length, 0);
  assert.equal(linux.options.cwd, "/tmp/a b");
});
