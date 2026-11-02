import Mock from "apipost-mock";
import { createScriptMockFacade } from "../src/script-mock-template.mjs";

// Only this constructor is returned from the private enclosing script IIFE.
// No raw core, dynamic module loader or placeholder evaluator is published.
export function install(reserve) {
  return createScriptMockFacade(Mock.mock.bind(Mock), reserve);
}
