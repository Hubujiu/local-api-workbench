import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { desktopLayout } from "../desktop/build-layout.mjs";
test("desktop layouts resolve actual packaged executable and resources for each target", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const layout = desktopLayout(platform);
    assert(layout.executable.startsWith(layout.root));
    assert(layout.app.startsWith(layout.root));
    assert.equal(layout.platform, platform);
  }
  assert(
    desktopLayout("darwin").app.endsWith(
      path.join("Contents", "Resources", "app"),
    ),
  );
  assert(desktopLayout("win32").executable.endsWith("LocalAPI.exe"));
  assert.throws(() => desktopLayout("unsupported"));
});
