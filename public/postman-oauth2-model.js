// Bounded Postman saved-token policy; deliberately distinct from native OAuth2.
const fields = [
  "accessToken",
  "addTokenTo",
  "tokenType",
  "headerPrefix",
  // Fixture-backed opaque strings, never interpreted as acquisition settings.
  "callBackUrl",
  "authUrl",
  "accessTokenUrl",
  "clientId",
  "clientSecret",
  "scope",
  "requestAccessTokenLocally",
];
const fail = () => {
  throw Error("Postman OAuth2 令牌策略无效或不受支持");
};
function entries(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail();
  return Reflect.ownKeys(value).map((key) => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !d.enumerable || !Object.hasOwn(d, "value"))
      fail();
    return [key, d.value];
  });
}
export function postmanOAuth2Definition(auth) {
  if (!auth || typeof auth !== "object") return undefined;
  // Detect inherited markers as well, then reject the non-plain record below.
  if (!("postmanOAuth2" in auth)) return undefined;
  const outer = entries(auth);
  if (
    outer.length !== 2 ||
    outer.some(([k]) => !["type", "postmanOAuth2"].includes(k)) ||
    outer.find(([k]) => k === "type")?.[1] !== "oauth2"
  )
    fail();
  const result = {};
  let totalValueBytes = 0;
  for (const [key, value] of entries(
    outer.find(([k]) => k === "postmanOAuth2")[1],
  )) {
    if (key === "version") {
      if (value !== 1) fail();
    } else {
      if (
        !fields.includes(key) ||
        typeof value !== "string" ||
        value.length > 8192 ||
        !value.isWellFormed() ||
        /[\x00-\x1f\x7f]/.test(value)
      )
        fail();
      const valueBytes = new TextEncoder().encode(value).length;
      totalValueBytes += valueBytes;
      if (valueBytes > 8192 || totalValueBytes > 32768) fail();
    }
    result[key] = value;
  }
  if (
    result.version !== 1 ||
    (result.addTokenTo !== undefined &&
      !["", "header", "queryParams"].includes(result.addTokenTo)) ||
    (result.tokenType !== undefined &&
      !["", "bearer"].includes(result.tokenType.toLowerCase()))
  )
    fail();
  return result;
}
export function importPostmanOAuth2(rows = []) {
  if (
    !Array.isArray(rows) ||
    Object.getPrototypeOf(rows) !== Array.prototype ||
    rows.length > fields.length
  )
    fail();
  const descriptors = Object.getOwnPropertyDescriptors(rows);
  if (Reflect.ownKeys(descriptors).length !== rows.length + 1) fail();
  const definition = { version: 1 };
  for (let index = 0; index < rows.length; index++) {
    const d = descriptors[index];
    if (!d?.enumerable || !Object.hasOwn(d, "value")) fail();
    const row = Object.fromEntries(entries(d.value));
    if (
      Object.keys(row).some(
        (k) => !["key", "value", "type", "disabled"].includes(k),
      ) ||
      !fields.includes(row.key) ||
      Object.hasOwn(definition, row.key) ||
      (Object.hasOwn(row, "type") && row.type !== "string") ||
      (Object.hasOwn(row, "disabled") && row.disabled !== false)
    )
      fail();
    definition[row.key] = row.value;
  }
  const auth = { type: "oauth2", postmanOAuth2: definition };
  postmanOAuth2Definition(auth);
  return auth;
}
// Do not resolve an irrelevant prefix for query/no-token policies.
export function resolvePostmanOAuth2(auth, interpolate, variables) {
  const definition = postmanOAuth2Definition(auth);
  if (definition === undefined) return undefined;
  if (definition.accessToken) {
    definition.accessToken = interpolate(definition.accessToken, variables);
    if (
      definition.accessToken &&
      (!definition.addTokenTo || definition.addTokenTo === "header") &&
      definition.headerPrefix
    )
      definition.headerPrefix = interpolate(definition.headerPrefix, variables);
  }
  postmanOAuth2Definition({ type: "oauth2", postmanOAuth2: definition });
  return definition;
}

// Preflight before callers clone/serialize definitions, including frozen copies.
export function validatePostmanOAuth2Project(project) {
  for (const request of project.requests || [])
    postmanOAuth2Definition(request.auth);
  for (const plan of project.plans || [])
    for (const step of plan.steps || [])
      postmanOAuth2Definition(step.request?.auth);
  for (const item of project.cases || [])
    postmanOAuth2Definition(item.request?.auth);
  postmanOAuth2Definition(project.settings?.globalAuth);
  for (const auth of Object.values(project.settings?.folderAuth || {}))
    postmanOAuth2Definition(auth);
}

// MCP partial overrides need descriptor inspection before JSON serialization.
// Leave ordinary unmarked inputs on their existing path.
export function preflightPostmanOAuth2Input(auth, input) {
  const definition = postmanOAuth2Definition(auth);
  if (!input || typeof input !== "object") return input;
  const descriptor = Object.getOwnPropertyDescriptor(input, "auth");
  if (!descriptor) {
    if (definition !== undefined && "auth" in input) fail();
    return input;
  }
  if (!Object.hasOwn(descriptor, "value")) {
    if (definition !== undefined) fail();
    return input;
  }
  const patch = descriptor.value;
  const visibleMarker =
    patch && typeof patch === "object" && "postmanOAuth2" in patch;
  if (definition === undefined) {
    if (visibleMarker) fail();
    return input;
  }
  if (!descriptor.enumerable) fail();
  const safePatch = Object.fromEntries(entries(patch));
  if (
    Object.keys(safePatch).some(
      (key) => !["type", "postmanOAuth2"].includes(key),
    )
  )
    fail();
  const candidate = { type: "oauth2", postmanOAuth2: definition };
  if (Object.hasOwn(safePatch, "type")) candidate.type = safePatch.type;
  if (Object.hasOwn(safePatch, "postmanOAuth2")) {
    safePatch.postmanOAuth2 = Object.fromEntries(
      entries(safePatch.postmanOAuth2),
    );
    candidate.postmanOAuth2 = { ...definition, ...safePatch.postmanOAuth2 };
  }
  postmanOAuth2Definition(candidate);
  // Preserve existing non-auth input descriptors/semantics, but do not reread
  // caller-owned auth records after their descriptor-safe validation.
  const descriptors = Object.getOwnPropertyDescriptors(input);
  descriptors.auth = { ...descriptor, value: safePatch };
  return Object.create(Object.getPrototypeOf(input), descriptors);
}
