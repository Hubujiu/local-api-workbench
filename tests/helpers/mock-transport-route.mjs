export function isMockTransportRoute(pathname) {
  const [first, second, third] = pathname.split("/").filter(Boolean);
  return (
    first === "mock" ||
    (first === "app" && second === "mock" && third === "project")
  );
}
