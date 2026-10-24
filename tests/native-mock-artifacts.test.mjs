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
  const config = join(root, "empty-gitconfig");
  await writeFile(config, "");
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (phase, args, options = {}) => {
    try {
      return execFileSync("git", args, {
        env,
        timeout: 10000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        ...options,
      });
    } catch (error) {
      throw new Error(
        "Git integrity fixture failed at " + phase + ": " + error.message,
        { cause: error },
      );
    }
  };
  git("init", ["init", "--quiet", "--template=", root]);
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
  // Feed the reviewed bytes through a file, not a large synchronous stdin pipe.
  // No clean filter is applied here; the subsequent checkout filter is the test.
  const source = join(root, "source.js");
  await writeFile(source, bytes);
  const blob = git(
    "hash-object",
    ["hash-object", "-w", "--no-filters", source],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const filtered = git(
    "cat-file checkout filter",
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
