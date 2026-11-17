import { desktopLayout } from "../desktop/build-layout.mjs";
import { verifyPortableManifest } from "./portable-integrity.mjs";

const verified = await verifyPortableManifest(desktopLayout().root);
console.log(`PORTABLE_MANIFEST_INTEGRITY_PASS ${JSON.stringify(verified)}`);
