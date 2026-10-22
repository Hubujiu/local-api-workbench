import { jwtAlgorithms } from "./jwt-auth-model.js";
export const asapAlgorithms = jwtAlgorithms.filter(
  (algorithm) => !algorithm.startsWith("HS"),
);
