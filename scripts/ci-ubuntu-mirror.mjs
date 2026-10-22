import { readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const azure = /https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?(?=[ \t]|$)/g;
const canonical = "https://archive.ubuntu.com/ubuntu/";
// Preserve source options, suites and signatures; recognize active URI fields only.
export function useCanonicalUbuntuArchive(source) {
  return source
    .split("\n")
    .map((line) => {
      if (/^[ \t]*#/.test(line)) return line;
      if (/^[ \t]*URIs:/i.test(line)) {
        const colon = line.indexOf(":");
        return (
          line.slice(0, colon + 1) +
          line.slice(colon + 1).replace(azure, canonical)
        );
      }
      const legacy = line.match(
        /^([ \t]*deb(?:-src)?[ \t]+(?:\[[^\]\r\n]*\][ \t]+)?)(.*)$/,
      );
      if (legacy) {
        const tail = legacy[2];
        const match = tail.match(
          /^https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?(?=[ \t]|$)/,
        );
        return match
          ? legacy[1] + canonical + tail.slice(match[0].length)
          : line;
      }
      // mirror+file sources store one URL per line in /etc/apt/mirrors/*.list.
      if (
        /^[ \t]*https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?[ \t]*\r?$/.test(
          line,
        )
      )
        return line.replace(
          /https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?/,
          canonical,
        );
      return line;
    })
    .join("\n");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw Error("Only intended for ephemeral GitHub Actions runners");
  const files = ["/etc/apt/sources.list"];
  for (const directory of ["/etc/apt/sources.list.d", "/etc/apt/mirrors"]) {
    const names = await readdir(directory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of names)
      if (/\.(list|sources)$/.test(name))
        files.push(path.join(directory, name));
  }
  let changed = 0,
    scanned = 0;
  for (const file of files) {
    const stat = await lstat(file).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat?.isFile()) continue;
    const source = await readFile(file, "utf8"),
      updated = useCanonicalUbuntuArchive(source);
    scanned++;
    if (updated !== source) {
      await writeFile(file, updated);
      changed++;
      console.log("Updated Ubuntu mirror URI in " + file);
    }
    if (
      updated
        .split("\n")
        .some(
          (line) =>
            !line.trimStart().startsWith("#") &&
            line.includes("azure.archive.ubuntu.com"),
        )
    )
      throw Error("Unrecognized active Azure mirror entry in " + file);
  }
  console.log(
    `Ubuntu archive configuration: scanned ${scanned} files, changed ${changed}; existing suites and signatures preserved`,
  );
}
