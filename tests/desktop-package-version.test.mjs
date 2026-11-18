import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkedDesktopVersion,
  desktopSourceVersion,
  packagedDesktopVersion,
} from "../scripts/desktop-package-version.mjs";
import { desktopLayout } from "../desktop/build-layout.mjs";

const run = promisify(execFile);
const manifestScript = fileURLToPath(
  new URL("../scripts/build-manifest.mjs", import.meta.url),
);

async function fixture(t, version) {
  const root = await mkdtemp(path.join(os.tmpdir(), "localapi-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const relativeApp = path.relative(process.cwd(), desktopLayout().app);
  const app = path.join(root, relativeApp);
  await mkdir(app, { recursive: true });
  await mkdir(path.join(root, "desktop"));
  const pkg = path.join(app, "package.json");
  const json = (file, value) =>
    writeFile(path.join(root, file), JSON.stringify(value));
  for (const file of ["package.json", "desktop/package.json"])
    await json(file, { version });
  for (const file of ["package-lock.json", "desktop/package-lock.json"]) {
    await json(file, { version, packages: { "": { version } } });
  }
  await writeFile(
    pkg,
    JSON.stringify({
      version,
      name: "local-api-workbench",
      main: "desktop/main.mjs",
    }),
  );
  return { root, app, pkg, json };
}

test("desktop version parses canonical MSI-compatible releases only", () => {
  for (const version of ["0.1.1", "10.35.9999", "255.255.65535"]) {
    assert.equal(checkedDesktopVersion(version), version);
  }
  for (const version of [
    undefined,
    null,
    2,
    "01.2.3",
    "1.2",
    "1.2.3-beta",
    "256.0.0",
    "0.0.65536",
    "1.2.3\n",
    "99999999.0.1",
  ]) {
    assert.throws(
      () => checkedDesktopVersion(version),
      /canonical desktop release version/,
    );
  }
});

test("source and both lockfile roots must agree", async (t) => {
  const { root, json } = await fixture(t, "0.1.1");
  assert.equal(await desktopSourceVersion(root), "0.1.1");
  await json("desktop/package-lock.json", {
    version: "0.1.1",
    packages: { "": { version: "0.1.0" } },
  });
  await assert.rejects(desktopSourceVersion(root), /does not match/);
});

test("actual manifest pins the installed app version, rejects foreign or stale app metadata", async (t) => {
  const { root, app, pkg } = await fixture(t, "0.1.1");
  const head = "a".repeat(40);
  const options = { cwd: root, env: { ...process.env, BUILD_HEAD: head } };
  const manifest = path.join(root, "dist", "LocalAPI", "build-manifest.json");
  const meta = {
    version: "0.1.0",
    name: "local-api-workbench",
    main: "desktop/main.mjs",
  };
  await writeFile(pkg, JSON.stringify(meta));
  await assert.rejects(
    run(process.execPath, [manifestScript], options),
    /version differs/,
  );
  await assert.rejects(readFile(manifest), { code: "ENOENT" });
  await writeFile(
    pkg,
    JSON.stringify({ ...meta, version: "0.1.1", main: "other.mjs" }),
  );
  await assert.rejects(
    packagedDesktopVersion(app, "0.1.1"),
    /application identity/,
  );
  await writeFile(pkg, JSON.stringify({ ...meta, version: "0.1.1" }));
  await run(process.execPath, [manifestScript], options);
  const result = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(result.head, head);
  assert.equal(result.version, "0.1.1");
  assert.ok(
    result.files.some((file) =>
      /resources\/app\/package[.]json$/i.test(file.path),
    ),
  );
});
