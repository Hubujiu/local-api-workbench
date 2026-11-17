import assert from "node:assert/strict";
import path from "node:path";
import { desktopLayout } from "../../desktop/build-layout.mjs";

export function desktopJourneyOptions(args, platform = process.platform) {
  let crash = false,
    packageRoot;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--crash") {
      assert.equal(crash, false, "Duplicate crash option");
      crash = true;
    } else if (arg === "--package-root") {
      assert.equal(packageRoot, undefined, "Duplicate package root");
      packageRoot = args[++i];
      assert.ok(
        packageRoot && path.isAbsolute(packageRoot),
        "Absolute extracted package root required",
      );
    } else {
      throw Error("Unknown journey option");
    }
  }
  const layout = desktopLayout(platform);
  return {
    crash,
    downloaded: packageRoot !== undefined,
    executable:
      packageRoot === undefined
        ? layout.executable
        : path.join(packageRoot, path.relative(layout.root, layout.executable)),
  };
}
