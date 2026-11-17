// Cancellation owns only this invocation's transport, never a saved grant.
export function databaseCancelled() {
  const error = Error("数据库操作已取消");
  error.name = "AbortError";
  error.code = "DATABASE_QUERY_CANCELLED";
  return error;
}
export function checkDatabaseSignal(signal) {
  if (signal?.aborted) throw databaseCancelled();
}
export function observeDatabaseStream(stream) {
  // An unconnected Socket still emits close after destroy. Keep an error sink
  // while its driver rejects pending work; close is the resource boundary.
  const ignore = () => {};
  stream.on("error", ignore);
  const closed = stream.closed
    ? Promise.resolve()
    : new Promise((resolve) => stream.once("close", resolve));
  return { stream, closed, close: () => stream.destroy() };
}
