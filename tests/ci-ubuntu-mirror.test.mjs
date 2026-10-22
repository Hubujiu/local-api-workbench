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
