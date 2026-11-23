import { rejectHTTPPreWait } from "./http-pre-wait-contract.js";
import { validatePostmanOAuth2Project } from "./postman-oauth2-model.js";
/** New plan steps copy interface data but do not implicitly execute interface-page scripts. */
export function snapshotInterfaceForPlan(request) {
  rejectHTTPPreWait(request, "冻结计划模板");
  validatePostmanOAuth2Project({ requests: [request] });
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
