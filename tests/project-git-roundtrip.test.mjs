import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Store } from "../src/runtime.mjs";

const exec = promisify(execFile);

test("offline Git clone reopens a Workbench project and restores an API without importing runtime history", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "localapi-git-roundtrip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "git-home");
  await mkdir(home);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
  );
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
  });
  const git = async (cwd, ...args) =>
    (
      await exec(
        "git",
        ["-c", "core.hooksPath=" + home, "-c", "commit.gpgSign=false", ...args],
        {
          cwd,
          env,
          timeout: 15_000,
        },
      )
    ).stdout.trim();

  const author = new Store(path.join(root, "author"));
  const project = await author.create("离线接口项目");
  project.requests = [
    {
      id: "status",
      name: "Status v1",
      method: "GET",
      url: "http://127.0.0.1:1/v1",
    },
    {
      id: "health",
      name: "Health",
      method: "GET",
      url: "http://127.0.0.1:1/health",
    },
  ];
  await author.save(project);
  const withHistory = await author.get(project.id);
  withHistory.history = [{ id: "never-share-this-local-history", status: 200 }];
  const source = author.directory(project.id);
  const customIgnore = "# team notes\nnotes.txt\n";
  await writeFile(
    path.join(source, ".gitignore"),
    customIgnore + "!/history/\n",
  );
  await author.save(withHistory, { activity: true });
  assert.ok(
    (await readFile(path.join(source, ".gitignore"), "utf8")).startsWith(
      customIgnore + "!/history/\n",
    ),
  );
  await git(source, "init", "--initial-branch=main", "--template=");
  await git(source, "config", "user.name", "Workbench Test");
  await git(source, "config", "user.email", "workbench-test@example.invalid");
  await git(source, "add", "--", ".");
  await git(source, "commit", "-m", "Initial project");
  const baseline = await git(source, "rev-parse", "HEAD");
  const live = await author.get(project.id);
  assert.equal(live.history[0]?.id, "never-share-this-local-history");
  assert.equal(
    await git(
      source,
      "ls-files",
      "--",
      "history",
      ".transaction.json",
      ".local-history.json",
    ),
    "",
  );

  live.requests[0].name = "Status v2";
  live.requests[0].url = "http://127.0.0.1:1/v2";
  await author.save(live);
  const changed = (await git(source, "diff", "--name-only", baseline)).split(
    "\n",
  );
  const apiFile = changed.find((name) => name.startsWith("apis/"));
  assert.ok(apiFile);
  assert.deepEqual(
    changed.filter((name) => name.startsWith("apis/")),
    [apiFile],
  );
  assert.ok(
    changed.every((name) => name === "project.json" || name === apiFile),
  );
  await git(source, "add", "--", ".");
  await git(source, "commit", "-m", "Edit one API");

  const collaboratorRoot = path.join(root, "collaborator");
  await mkdir(collaboratorRoot);
  await git(collaboratorRoot, "clone", "--no-local", "--", source, project.id);
  const collaborator = new Store(collaboratorRoot);
  const found = await collaborator.list();
  assert.deepEqual(
    found.map(({ id }) => id),
    [project.id],
  );
  const saved = await collaborator.get(project.id);
  assert.equal(saved.name, project.name);
  assert.equal(saved.requests[0].url, "http://127.0.0.1:1/v2");
  assert.equal(saved.requests[1].name, "Health");
  assert.deepEqual(saved.history, []);
  const checkout = collaborator.directory(project.id);
  assert.equal(await git(checkout, "status", "--porcelain"), "");

  await git(checkout, "restore", "--source", baseline, "--", apiFile);
  await assert.rejects(collaborator.save(saved), /其他窗口|文件/);
  const reopened = await new Store(collaboratorRoot).get(project.id);
  assert.equal(reopened.requests[0].name, "Status v1");
  assert.equal(reopened.requests[0].url, "http://127.0.0.1:1/v1");
  assert.equal(reopened.requests[1].name, "Health");
  assert.deepEqual(reopened.history, []);
  reopened.requests[0].name = "Collaborator";
  await collaborator.save(reopened);
  assert.equal(
    (await new Store(collaboratorRoot).get(project.id)).requests[0].name,
    "Collaborator",
  );
  assert.equal(
    await git(checkout, "ls-files", "--others", "--exclude-standard"),
    "",
  );
  assert.equal((await author.get(project.id)).requests[0].name, "Status v2");
});
