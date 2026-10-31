// Bounded Postman saved-token policy; deliberately distinct from native OAuth2.
const fields = ["accessToken", "addTokenTo", "tokenType", "headerPrefix"];
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
  for (const [key, value] of entries(
    outer.find(([k]) => k === "postmanOAuth2")[1],
  )) {
    if (key === "version") {
      if (value !== 1) fail();
    } else if (
      !fields.includes(key) ||
      typeof value !== "string" ||
      value.length > 8192 ||
      !value.isWellFormed() ||
      new TextEncoder().encode(value).length > 8192 ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      fail();
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
    rows.length > 4
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

// Preflight before callers clone/serialize definitions, including disabled repeat
// leaves and immutable historical snapshots. Never evaluate auth accessors.
export function validatePostmanOAuth2Project(project) {
  const read = (value, key) => {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      (!descriptor && key in value) ||
      (descriptor && !Object.hasOwn(descriptor, "value"))
    )
      fail();
    return descriptor?.value;
  };
  const request = (value) => postmanOAuth2Definition(read(value, "auth"));
  const seen = new Set();
  // Bound each definition tree, not the sum of independent plans/history.
  const steps = (items, depth = 0, budget = { nodes: 0 }) => {
    if (items === undefined) return;
    if (!Array.isArray(items) || depth > 32 || seen.has(items)) fail();
    seen.add(items);
    for (let index = 0; index < items.length; index++) {
      if (++budget.nodes > 100000) fail();
      const step = read(items, String(index));
      request(read(step, "request"));
      steps(read(step, "steps"), depth + 1, budget);
    }
    seen.delete(items);
  };
  for (const value of project.requests || []) request(value);
  for (const plan of project.plans || []) steps(read(plan, "steps"));
  for (const item of project.cases || []) request(read(item, "request"));
  for (const run of project.runs || [])
    steps(read(read(run, "snapshot"), "steps"));
  const settings = read(project, "settings");
  postmanOAuth2Definition(read(settings, "globalAuth"));
  const folders = read(settings, "folderAuth");
  for (const key of Reflect.ownKeys(folders || {}))
    postmanOAuth2Definition(read(folders, key));
}
