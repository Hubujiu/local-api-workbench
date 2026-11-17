import { lstat, readdir, readlink, open } from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

// Build-time inspection only. The completed staging tree must be quiescent.
// Never descend through a symlink or realpath/read an external target.
export async function inspectPortableTree(root) {
  root = path.resolve(root);
  if (!(await lstat(root)).isDirectory())
    throw Error("Portable root must be a directory");
  const entries = new Map([["", { type: "directory" }]]);
  async function visit(relative, depth) {
    if (depth > 128) throw Error("Portable directory depth exceeded");
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      if (/[\\\x00-\x1f\x7f]/u.test(name))
        throw Error("Non-portable entry name");
      const file = relative ? `${relative}/${name}` : name;
      const stat = await lstat(path.join(root, file));
      let entry;
      if (stat.isSymbolicLink()) {
        const target = await readlink(path.join(root, file));
        if (
          !target ||
          Buffer.byteLength(target) > 4096 ||
          path.posix.isAbsolute(target) ||
          path.win32.isAbsolute(target) ||
          /^[A-Za-z]:/.test(target) ||
          /[\x00-\x1f\x7f]/u.test(target) ||
          (process.platform !== "win32" && target.includes("\\"))
        )
          throw Error(`Non-relative portable link: ${file}`);
        entry = {
          type: "symlink",
          target,
          traversalTarget:
            process.platform === "win32"
              ? target.replaceAll("\\", "/")
              : target,
        };
      } else if (stat.isDirectory()) entry = { type: "directory" };
      else if (stat.isFile()) entry = { type: "file" };
      else throw Error(`Unsupported portable entry: ${file}`);
      entries.set(file, entry);
      if (entries.size > 100000) throw Error("Portable entry count exceeded");
      if (entry.type === "directory") await visit(file, depth + 1);
    }
  }
  await visit("", 0);
  function resolveLink(file) {
    const pending = file.split("/");
    const resolved = [];
    const seen = new Set();
    let expansions = 0;
    while (pending.length) {
      const part = pending.shift();
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!resolved.length)
          throw Error(`Portable link escapes root: ${file}`);
        resolved.pop();
        continue;
      }
      const candidate = [...resolved, part].join("/");
      const entry = entries.get(candidate);
      if (!entry) throw Error(`Dangling portable link: ${file}`);
      if (entry.type === "symlink") {
        const state = `${candidate}\0${pending.join("/")}`;
        if (seen.has(state) || ++expansions > 40)
          throw Error(`Portable link cycle or chain limit: ${file}`);
        seen.add(state);
        pending.unshift(...entry.traversalTarget.split("/"));
      } else {
        if (pending.length && entry.type !== "directory")
          throw Error(`Non-directory portable link component: ${file}`);
        resolved.push(part);
      }
    }
    return {
      resolved: resolved.join("/"),
      resolvedType: entries.get(resolved.join("/")).type,
    };
  }
  const links = [];
  const files = [];
  for (const [file, entry] of entries) {
    if (entry.type === "file") files.push(file);
    if (entry.type === "symlink") {
      if (links.length >= 10000) throw Error("Portable link count exceeded");
      links.push({ path: file, target: entry.target, ...resolveLink(file) });
    }
  }
  return {
    files: files.sort(),
    links: links.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  };
}

export async function portableChecksums(root) {
  const inventory = await inspectPortableTree(root);
  if (
    inventory.links.some(
      (link) =>
        link.path === "build-manifest.json" ||
        link.resolved === "build-manifest.json",
    )
  )
    throw Error("Portable manifest must not be a symlink or link target");
  const manifestStat = await lstat(
    path.join(root, "build-manifest.json"),
  ).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (manifestStat && !manifestStat.isFile())
    throw Error("Portable manifest must be a regular file");
  const targets = new Map(
    inventory.files
      .filter((file) => file !== "build-manifest.json")
      .map((file) => [file, file]),
  );
  for (const link of inventory.links)
    if (link.resolvedType === "file") targets.set(link.path, link.resolved);
  const files = [];
  for (const file of [...targets.keys()].sort()) {
    const hash = createHash("sha256");
    // Resolved components are regular directories/files in the validated graph.
    // Do not open a symlink path to hash its target.
    for await (const chunk of createReadStream(
      path.join(root, targets.get(file)),
    ))
      hash.update(chunk);
    files.push({ path: file, sha256: hash.digest("hex") });
  }
  return { files, links: inventory.links };
}

export async function verifyPortableManifest(root) {
  const actual = await portableChecksums(root);
  const handle = await open(path.join(root, "build-manifest.json"), "r");
  let manifest;
  try {
    const limit = 32 * 1024 * 1024;
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw Error("Portable manifest size/type invalid");
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        used,
        bytes.length - used,
        null,
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== stat.size)
      throw Error("Portable manifest changed while reading");
    manifest = JSON.parse(bytes.subarray(0, used).toString("utf8"));
  } finally {
    await handle.close();
  }
  if (
    manifest.integrityVersion !== 1 ||
    JSON.stringify(manifest.files) !== JSON.stringify(actual.files) ||
    JSON.stringify(manifest.links) !== JSON.stringify(actual.links)
  )
    throw Error("Portable manifest does not match complete package contents");
  return { files: actual.files.length, links: actual.links.length };
}
