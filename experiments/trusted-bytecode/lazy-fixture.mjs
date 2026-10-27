import { responseCompatibilitySource } from "../../src/script-response.mjs";

// Host-test helper only: never imported by production or selected with guest
// bytes, paths or options. Its callers supply reviewed, fixed fixture snippets.
// Evaluation, dumping and handle release all remain in the same charged call.
// The outer owner also covers an exception raised by budget.run's final check.
export function evaluateGuest(session, fixedTestSource, label = "guest") {
  let result;
  try {
    return session.budget.run(label, () => {
      result = session.context.evalCode(
        fixedTestSource,
        "localapi:trusted/lazy-schema-test.js",
        { type: "global" },
      );
      try {
        if (result.error) {
          const error = session.context.dump(result.error);
          throw Error(error?.message || "Guest evaluation failed");
        }
        return session.context.dump(result.value);
      } finally {
        (result.error || result.value).dispose();
        result = undefined;
      }
    });
  } finally {
    (result?.error || result?.value)?.dispose();
  }
}

export function installActualSchemaAPI(session) {
  // Identical bytecode prerequisites in both schema modes. This is the unchanged
  // production response API with a fixed scaffold, not the production worker.
  session.load("library-prelude", "bytecode");
  session.load("libraries", "bytecode");
  evaluateGuest(
    session,
    `globalThis.pm = { response: {}, expect: chai.expect };
     globalThis.apt = { expect: chai.expect };
     (${responseCompatibilitySource})({
       response: {
         status: 200, statusText: 'OK', duration: 3, size: 28,
         headers: { 'content-type': 'application/json', 'x-fixture': 'yes' },
         body: '{"name":"Ada","enabled":true}',
         json: { name: 'Ada', enabled: true }
       }, pm, apt
     }); undefined;`,
    "install-actual-schema-api",
  );
}
