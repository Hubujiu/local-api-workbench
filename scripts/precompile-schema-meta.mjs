import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";

// Only the fixed, trusted Draft 7 meta-schema is compiled at build time.
// Every user schema is still self-validated and compiled inside its own VM.
export function draft7MetaPlugin() {
  const require = createRequire(import.meta.url);
  const bytes = readFileSync(
    require.resolve("ajv/dist/refs/json-schema-draft-07.json"),
  );
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    "f7e8b13cad4fecff9771f3626fef33e20e59027b90938a28fd9d2f6c17cd0773"
  )
    throw Error("Draft 7 meta-schema changed; review before rebuilding");
  return {
    name: "trusted-draft7-meta",
    setup(build) {
      build.onResolve({ filter: /^trusted-draft7-meta:[01]{2}$/ }, (args) => ({
        path: args.path,
        namespace: "trusted-draft7-meta",
      }));
      build.onLoad(
        { filter: /.*/, namespace: "trusted-draft7-meta" },
        (args) => {
          const ajv = new Ajv({
            allErrors: args.path.endsWith("10") || args.path.endsWith("11"),
            verbose: args.path.endsWith("01") || args.path.endsWith("11"),
            strict: false,
            logger: false,
            ownProperties: true,
            code: { source: true },
          });
          addFormats(ajv, { keywords: false });
          const validate = ajv.getSchema(
            "http://json-schema.org/draft-07/schema",
          );
          return {
            contents: standaloneCode(ajv, validate),
            loader: "js",
            resolveDir: process.cwd(),
          };
        },
      );
    },
  };
}
