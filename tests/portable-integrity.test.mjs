import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  inspectPortableTree,
  portableChecksums,
  verifyPortableManifest,
} from "../scripts/portable-integrity.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, file, text = "fixture") {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}
async function link(root, file, target, type = "file") {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await symlink(target, path.join(root, file), type);
}

test("relative production bin links survive copy and relocation without their source tree", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "production/node_modules");
  await put(source, "tool/bin.js", "synthetic tool; never executed");
  await link(source, ".bin/tool", "../tool/bin.js");
  const staged = path.join(root, "staged/resources/app/node_modules");
  await cp(source, staged, { recursive: true, verbatimSymlinks: true });
  const originalTarget =
    process.platform === "win32" ? "..\\tool\\bin.js" : "../tool/bin.js";
  assert.equal(await readlink(path.join(staged, ".bin/tool")), originalTarget);
  await rm(path.join(root, "production"), { recursive: true });
  await rename(path.join(root, "staged"), path.join(root, "relocated"));
  const inventory = await inspectPortableTree(path.join(root, "relocated"));
  assert.deepEqual(inventory.links, [
    {
      path: "resources/app/node_modules/.bin/tool",
      target: originalTarget,
      resolved: "resources/app/node_modules/tool/bin.js",
      resolvedType: "file",
    },
  ]);
  const manifest = await portableChecksums(path.join(root, "relocated"));
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files[0].sha256, manifest.files[1].sha256);
});

test("all fourteen framework link shapes resolve without following aliases", async (t) => {
  const root = await fixture(t);
  for (const name of [
    "Mantle",
    "Squirrel",
    "ReactiveObjC",
    "Electron Framework",
  ]) {
    const base = `LocalAPI.app/Contents/Frameworks/${name}.framework`;
    await put(
      root,
      `${base}/Versions/A/${name}`,
      "synthetic executable bytes; never run",
    );
    await put(root, `${base}/Versions/A/Resources/info`, "metadata");
    await link(root, `${base}/Versions/Current`, "A", "dir");
    await link(root, `${base}/${name}`, `Versions/Current/${name}`);
    await link(root, `${base}/Resources`, "Versions/Current/Resources", "dir");
    if (name === "Electron Framework") {
      for (const directory of ["Libraries", "Helpers"]) {
        await put(
          root,
          `${base}/Versions/A/${directory}/fixture`,
          "synthetic bytes",
        );
        await link(
          root,
          `${base}/${directory}`,
          `Versions/Current/${directory}`,
          "dir",
        );
      }
    }
  }
  const inventory = await inspectPortableTree(root);
  assert.equal(inventory.links.length, 14);
  assert(
    inventory.links.every((entry) => entry.resolved.includes("/Versions/A")),
  );
  await link(
    root,
    "resource-info",
    "LocalAPI.app/Contents/Frameworks/Mantle.framework/Resources/info",
  );
  const extended = await inspectPortableTree(root);
  assert.equal(
    extended.links.find((entry) => entry.path === "resource-info").resolved,
    "LocalAPI.app/Contents/Frameworks/Mantle.framework/Versions/A/Resources/info",
  );
});

test("portable manifest retains hidden files and ordinary Windows bin shims", async (t) => {
  const root = await fixture(t);
  const expected = [
    "LocalAPI.exe",
    "resources/app/node_modules/.bin/tool",
    "resources/app/node_modules/.bin/tool.cmd",
    "resources/app/node_modules/.bin/tool.ps1",
    "resources/app/node_modules/tool/.metadata",
    "resources/hidden/.keep",
  ];
  for (const file of expected) await put(root, file, file);
  await put(
    root,
    "build-manifest.json",
    "previous manifest excluded from its own hash",
  );
  const manifest = await portableChecksums(root);
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    expected.sort(),
  );
  assert.deepEqual(manifest.links, []);
  for (const entry of manifest.files)
    assert.equal(
      entry.sha256,
      createHash("sha256").update(entry.path).digest("hex"),
    );
});

test("final package verification rejects omitted hidden files, changed bytes and extra members", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    "resources/app/node_modules/.bin/tool.cmd",
    "synthetic Windows shim",
  );
  await put(
    root,
    "resources/app/node_modules/tool/.metadata",
    "hidden dependency metadata",
  );
  const snapshot = await portableChecksums(root);
  await put(
    root,
    "build-manifest.json",
    JSON.stringify({ integrityVersion: 1, ...snapshot }),
  );
  assert.deepEqual(await verifyPortableManifest(root), { files: 2, links: 0 });
  await rm(path.join(root, "resources/app/node_modules/.bin/tool.cmd"));
  await assert.rejects(verifyPortableManifest(root), /does not match/);
  await put(root, "resources/app/node_modules/.bin/tool.cmd", "changed shim");
  await assert.rejects(verifyPortableManifest(root), /does not match/);
  await put(
    root,
    "resources/app/node_modules/.bin/tool.cmd",
    "synthetic Windows shim",
  );
  await put(root, "unexpected", "must not upload without manifest");
  await assert.rejects(verifyPortableManifest(root), /does not match/);
});

test("final verification CLI fails closed on incomplete staged package without launching it", async (t) => {
  const cwd = await fixture(t);
  const root = path.join(cwd, "dist/LocalAPI");
  await put(
    root,
    "resources/app/node_modules/.bin/tool.cmd",
    "inert shim fixture",
  );
  const snapshot = await portableChecksums(root);
  await put(
    root,
    "build-manifest.json",
    JSON.stringify({ integrityVersion: 1, ...snapshot }),
  );
  const script = fileURLToPath(
    new URL("../scripts/verify-portable.mjs", import.meta.url),
  );
  const invoke = () =>
    spawnSync(process.execPath, [script], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    });
  const valid = invoke();
  assert.ifError(valid.error);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /PORTABLE_MANIFEST_INTEGRITY_PASS/);
  await rm(path.join(root, "resources/app/node_modules/.bin/tool.cmd"));
  const incomplete = invoke();
  assert.ifError(incomplete.error);
  assert.notEqual(incomplete.status, 0);
  assert.doesNotMatch(incomplete.stdout, /PORTABLE_MANIFEST_INTEGRITY_PASS/);
});

test("manifest link-target changes cannot hide behind identical file bytes", async (t) => {
  const root = await fixture(t);
  await put(root, "one", "same");
  await put(root, "two", "same");
  await link(root, "alias", "one");
  const snapshot = await portableChecksums(root);
  await put(
    root,
    "build-manifest.json",
    JSON.stringify({ integrityVersion: 1, ...snapshot }),
  );
  await verifyPortableManifest(root);
  assert.deepEqual(await portableChecksums(root), snapshot);
  await link(root, "manifest-alias", "build-manifest.json");
  await assert.rejects(portableChecksums(root), /link target/);
  await rm(path.join(root, "manifest-alias"));
  await rm(path.join(root, "alias"));
  await link(root, "alias", "two");
  await assert.rejects(verifyPortableManifest(root), /does not match/);
  await rm(path.join(root, "build-manifest.json"));
  await link(root, "build-manifest.json", "one");
  await assert.rejects(
    portableChecksums(root),
    /manifest must not be a symlink/,
  );
});

test("absolute links and lexical or intermediate escapes fail without following targets", async (t) => {
  const outer = await fixture(t);
  await put(outer, "external/secret", "synthetic outside sentinel");
  for (const target of [
    path.join(outer, "external/secret"),
    "../external/secret",
    "C:/runner/file",
    "C:runner-file",
    "\\\\server\\share\\file",
  ]) {
    const root = await mkdtemp(path.join(outer, "package-"));
    await link(root, "bad", target);
    await assert.rejects(inspectPortableTree(root), /Non-relative|escapes/);
    await assert.rejects(portableChecksums(root), /Non-relative|escapes/);
  }
  const root = await mkdtemp(path.join(outer, "package-"));
  await link(root, "folder", "../external", "dir");
  await link(root, "indirect", "folder/secret");
  await assert.rejects(inspectPortableTree(root), /escapes/);
  assert.equal(
    await readFile(path.join(outer, "external/secret"), "utf8"),
    "synthetic outside sentinel",
  );
});

test("dangling, cyclic, excessive chains and non-directory components fail closed", async (t) => {
  const outer = await fixture(t);
  for (const kind of [
    "missing",
    "cycle",
    "expanding-cycle",
    "not-directory",
    "long-chain",
  ]) {
    const root = await mkdtemp(path.join(outer, "package-"));
    if (kind === "missing") await link(root, "a", "missing");
    if (kind === "cycle") {
      await link(root, "a", "b");
      await link(root, "b", "a");
    }
    if (kind === "expanding-cycle") await link(root, "a", "a/more");
    if (kind === "not-directory") {
      await put(root, "file");
      await link(root, "a", "file/child");
    }
    if (kind === "long-chain") {
      await put(root, "end");
      for (let i = 0; i < 41; i++)
        await link(root, `link${i}`, i === 40 ? "end" : `link${i + 1}`);
    }
    await assert.rejects(
      inspectPortableTree(root),
      /Dangling|cycle or chain|Non-directory/,
      kind,
    );
  }
});

test("build validates before chmod/signing and manifest hashing; hidden upload remains dist-only", async () => {
  const read = (file) =>
    readFile(new URL(`../${file}`, import.meta.url), "utf8");
  const build = await read("scripts/build-desktop.mjs");
  assert.match(
    build,
    /cp\("production\/node_modules",[\s\S]*?recursive: true,\s*verbatimSymlinks: true/,
  );
  assert(
    build.indexOf("await inspectPortableTree(layout.root)") <
      build.indexOf("await chmod("),
  );
  assert(
    build.indexOf("await inspectPortableTree(layout.root)") <
      build.indexOf('"codesign"'),
  );
  const manifest = await read("scripts/build-manifest.mjs");
  assert.match(manifest, /await portableChecksums\(root\)/);
  const workflow = await read(".github/workflows/ci.yml");
  const upload = workflow
    .split("name: LocalAPI-${{ runner.os }}-portable")[1]
    .split("  source-format:")[0];
  assert.match(upload, /include-hidden-files: true/);
  assert(
    workflow.indexOf("run: node scripts/verify-portable.mjs") <
      workflow.indexOf("run: tar -czf"),
  );
  assert.match(upload, /dist\/LocalAPI-\$\{\{ runner.os \}\}\.tar\.gz/);
  assert.match(
    upload,
    /'dist\/LocalAPI' \|\| 'dist\/LocalAPI\/build-manifest.json'/,
  );
  assert.equal((workflow.match(/include-hidden-files: true/g) || []).length, 1);
  assert.doesNotMatch(upload, /\.\.\/|workspace|\.env|path: \./);
});
