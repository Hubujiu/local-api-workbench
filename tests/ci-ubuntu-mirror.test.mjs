import test from "node:test";
import assert from "node:assert/strict";
import { useCanonicalUbuntuArchive } from "../scripts/ci-ubuntu-mirror.mjs";
test("CI mirror adjustment changes only exact Azure Ubuntu URI fields", () => {
  const source =
    "Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu\nSuites: noble noble-updates noble-security\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\n# http://azure.archive.ubuntu.com/ubuntu\nURIs: https://packages.microsoft.com/repos/code https://azure.archive.ubuntu.com/ubuntu/\n";
  const result = useCanonicalUbuntuArchive(source);
  assert.equal(
    result,
    source
      .replace(
        "URIs: http://azure.archive.ubuntu.com/ubuntu\n",
        "URIs: https://archive.ubuntu.com/ubuntu/\n",
      )
      .replace(
        "https://azure.archive.ubuntu.com/ubuntu/\n",
        "https://archive.ubuntu.com/ubuntu/\n",
      ),
  );
  assert.equal(useCanonicalUbuntuArchive(result), result);
  assert.equal(
    useCanonicalUbuntuArchive(
      "URIs: http://azure.archive.ubuntu.com/ubuntu-evil https://azure.archive.ubuntu.com.evil/ubuntu\n",
    ),
    "URIs: http://azure.archive.ubuntu.com/ubuntu-evil https://azure.archive.ubuntu.com.evil/ubuntu\n",
  );
});

test("CI recognizes legacy source lines and mirror indirection files without touching comments or options", () => {
  const source =
    "  Uris: http://azure.archive.ubuntu.com/ubuntu/\n" +
    "deb [arch=amd64 signed-by=/keys/ubuntu.gpg] http://azure.archive.ubuntu.com/ubuntu noble main\n" +
    "deb-src https://azure.archive.ubuntu.com/ubuntu/ noble-security main\n" +
    "http://azure.archive.ubuntu.com/ubuntu/\n" +
    "# http://azure.archive.ubuntu.com/ubuntu/\n" +
    "URIs: mirror+file:/etc/apt/mirrors/ubuntu.list\n";
  const changed = useCanonicalUbuntuArchive(source);
  assert.equal(
    changed.split("https://archive.ubuntu.com/ubuntu/").length - 1,
    4,
  );
  assert.match(changed, /signed-by=\/keys\/ubuntu.gpg/);
  assert.match(changed, /noble-security main/);
  assert(changed.includes("# http://azure.archive.ubuntu.com/ubuntu/"));
  assert(changed.includes("mirror+file:/etc/apt/mirrors/ubuntu.list"));
  assert.equal(useCanonicalUbuntuArchive(changed), changed);
});
