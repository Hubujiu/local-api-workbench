// Extracted existing raw import projection. RED checkpoint preserves old behavior.
export function importPostmanRawBody(body) {
  return {
    bodyType: body.options?.raw?.language === "json" ? "json" : "raw",
    body: body.raw || "",
  };
}
