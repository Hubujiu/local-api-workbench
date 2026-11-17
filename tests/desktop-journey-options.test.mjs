import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { desktopJourneyOptions } from "./helpers/desktop-journey-options.mjs";
import { desktopLayout } from "../desktop/build-layout.mjs";

test("default journey still uses built package", () => {
  assert.deepEqual(desktopJourneyOptions([]), {
    crash: false,
    downloaded: false,
    executable: desktopLayout().executable,
  });
});
test("downloaded journey must launch provided package rather than build directory on each OS", () => {
  const root = path.resolve("fresh-download");
  for (const platform of ["win32", "linux", "darwin"]) {
    const opts = desktopJourneyOptions(
      ["--package-root", root, "--crash"],
      platform,
    );
    assert.equal(opts.downloaded, true);
    assert.equal(opts.crash, true);
    assert.equal(
      opts.executable,
      path.join(
        root,
        platform === "win32"
          ? "LocalAPI.exe"
          : platform === "darwin"
            ? "LocalAPI.app/Contents/MacOS/Electron"
            : "LocalAPI",
      ),
    );
    assert.notEqual(opts.executable, desktopLayout(platform).executable);
  }
});
test("invalid or duplicate selectors fail closed", () => {
  for (const args of [
    ["--unknown"],
    ["--crash", "--crash"],
    ["--package-root"],
    ["--package-root", "relative"],
    ["--package-root", path.resolve("a"), "--package-root", path.resolve("b")],
  ])
    assert.throws(() => desktopJourneyOptions(args));
});
