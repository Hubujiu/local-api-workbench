import { postmanOAuth2Definition } from "./postman-oauth2-model.js";
/** New plan steps copy interface data but do not implicitly execute interface-page scripts. */
export function snapshotInterfaceForPlan(request) {
  postmanOAuth2Definition(request?.auth);
  return {
    ...structuredClone(request),
    sharedBeforeScripts: [],
    sharedAfterScripts: [],
    sharedScriptsSnapshot: true,
    before: [],
    after: [],
    beforeScript: "",
    afterScript: "",
  };
}
