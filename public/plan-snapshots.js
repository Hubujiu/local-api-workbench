/** New plan steps copy interface data but do not implicitly execute interface-page scripts. */
export function snapshotInterfaceForPlan(request) {
  return {
    ...structuredClone(request),
    before: [],
    after: [],
    beforeScript: "",
    afterScript: "",
  };
}
