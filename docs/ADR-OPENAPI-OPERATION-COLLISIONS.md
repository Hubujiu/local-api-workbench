# Reject lossy OpenAPI operation collisions

An OpenAPI Paths Object has one operation per path and HTTP method. Different
saved requests can project to the same key: their host, query values, fragment,
folder, or request identity may differ while their exported path and method do
not. Previously the last request silently overwrote earlier requests.

Export now rejects an already occupied path/method key, before overwriting any
operation. It does not merge examples, choose an origin, or invent a new path.
The error identifies the method and path and recommends the lossless native
project backup. Different methods on the same path remain valid. Deleted requests
remain excluded. Export operates on local output objects and does not modify the
saved source project; the server does not return a partial export on error.

Regression tests cover host/query/fragment collisions, source immutability,
distinct methods, and deleted requests. This does not claim that every OpenAPI
representability limitation is solved.

Source: https://spec.openapis.org/oas/v3.0.3.html#path-item-object
