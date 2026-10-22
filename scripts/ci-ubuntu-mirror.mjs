import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Same signed Ubuntu archive; only replace the slow hosted-runner mirror URI.
export function useCanonicalUbuntuArchive(source) {
  return source.replace(
    /^URIs:([^\r\n]*)/gm,
    (line, value) =>
      "URIs:" +
      value.replace(
        /https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?(?=\s|$)/g,
        "https://archive.ubuntu.com/ubuntu/",
      ),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw Error("Only intended for ephemeral GitHub Actions runners");
  const path = "/etc/apt/sources.list.d/ubuntu.sources";
  const source = await readFile(path, "utf8");
  const updated = useCanonicalUbuntuArchive(source);
  if (updated !== source) await writeFile(path, updated);
  console.log(
    updated === source
      ? "Ubuntu archive URI unchanged"
      : "Using canonical Ubuntu archive with existing signatures and suites",
  );
}
