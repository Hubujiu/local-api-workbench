// Deliberately smaller than cookie-token / Lodash path grammar. Inherited
// Object names are not trustworthy absence in the original ordinary object.
const reserved = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);
export const nativeCookieName = (name) =>
  typeof name === "string" &&
  /^[A-Za-z0-9_~\-]+$/.test(name) &&
  !reserved.has(name);
