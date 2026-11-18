// Internal fixed budget. Per-call Oracle timeout is 2 seconds; total includes
// connect, fetch and cleanup. No request-controlled timeout or retry.
export const ORACLE_READ_BUDGET = Object.freeze({
  total: 10000,
  cleanup: 500,
  killReceipt: 1000,
  capacity: 2,
});
