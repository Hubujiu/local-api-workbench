// Internal conservative defaults, not user/request configurable. Existing
// compiler/connect/query phase limits remain 2000/3000/2000 ms respectively.
export const SQLSERVER_PREP_BUDGET = Object.freeze({
  total: 10000,
  cleanup: 500,
  killReceipt: 1000,
  capacity: 2,
});
