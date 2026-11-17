import { createScriptMockGenerator } from "../src/script-mock-core.mjs";
import { createScriptMockFacade } from "../src/script-mock-template.mjs";

// Only this constructor is returned from the private enclosing script IIFE.
// No raw core, dynamic module loader or placeholder evaluator is published.
export function install(reserve) {
  return createScriptMockFacade(createScriptMockGenerator(), reserve);
}
