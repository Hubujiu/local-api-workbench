import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("native Mock exact-byte manifest survives Git CRLF checkout conversion settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "native-mock-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  await writeFile(
    join(root, ".gitattributes"),
    await readFile(new URL("../.gitattributes", import.meta.url)),
  );
  const bytes = await readFile(
    new URL("../src/vendor/native-mock-library.js", import.meta.url),
  );
  const manifest = JSON.parse(
    await readFile(
      new URL("../src/vendor/native-mock-library.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(hash(bytes), manifest.sha256);
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    input: bytes,
    encoding: "utf8",
  }).trim();
  const filtered = execFileSync(
    "git",
    [
      "-c",
      "core.autocrlf=true",
      "cat-file",
      "--filters",
      "--path=src/vendor/native-mock-library.js",
      blob,
    ],
    { cwd: root, maxBuffer: 1024 * 1024 },
  );
  assert.equal(
    hash(filtered),
    manifest.sha256,
    "checkout must preserve reviewed bytes rather than disabling or normalizing the integrity check",
  );
  const modified = Buffer.concat([bytes, Buffer.from("\n// changed")]);
  assert.notEqual(hash(modified), manifest.sha256);
});
