const startupPaths = new Set([
  "/",
  "/app.js",
  "/mock-target.js",
  "/http-debug-examples.js",
  "/api/session",
  "/api/projects",
]);
const errorNames = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
]);

export function bindExampleStartupTrace(page, origin, ownerPath) {
  const responses = new Map();
  const errors = new Set();
  function record(url, state) {
    const parsed = new URL(url);
    if (parsed.origin !== origin) return;
    if (parsed.pathname === ownerPath)
      responses.set("/api/projects/{fixture}", state);
    else if (startupPaths.has(parsed.pathname))
      responses.set(parsed.pathname, state);
  }
  page.on("pageerror", ({ name }) => {
    errors.add(errorNames.has(name) ? name : "OtherError");
  });
  page.on("response", (response) => record(response.url(), response.status()));
  page.on("requestfailed", (request) =>
    record(request.url(), "blocked or failed"),
  );
  return {
    status: (path) => responses.get(path),
    snapshot: () => ({
      responses: Object.fromEntries(responses),
      pageErrors: [...errors],
    }),
  };
}
