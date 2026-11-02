/*!
 * Modified admitted-JSON subset of apipost-mock 1.0.2 / Mock.js.
 * Copyright (c) 2022 Apipost Team; Copyright (c) 2015 nuysoft. MIT licensed.
 * Full notices: vendor/APIPOST-MOCK-LICENSE.txt, vendor/MOCKJS-UPSTREAM-LICENSE.txt.
 * Derivation and exact source-range hashes: scripts/script-mock-source.json.
 *
 * Retained: Handler.gen dispatch, unruled object enumeration, array generation,
 * integer rules, Random.integer/natural and single-item pick. Modified to use
 * captured natives and own data writes. Removed unsupported rules, callbacks,
 * references, increments, placeholder/eval, regex generation and Random catalogue.
 * This private generator requires the facade's validated, owned JSON clone;
 * it is not a standalone replacement for the complete public package API.
 */
export function createScriptMockGenerator() {
  const ownKeys = Reflect.ownKeys,
    apply = Reflect.apply,
    exec = RegExp.prototype.exec,
    array = Array.isArray,
    create = Object.create,
    define = Object.defineProperty,
    objectPrototype = Object.prototype,
    number = Number,
    random = Math.random,
    round = Math.round;
  const pattern =
    /^([^|\u0000-\u001f\u007f\u2028\u2029]+)\|(-?[1-9]\d*|0)(?:-(-?[1-9]\d*|0))?$/;
  const set = (target, key, value) => {
    const description = create(null);
    description.value = value;
    description.enumerable = true;
    description.writable = true;
    description.configurable = true;
    define(target, key, description);
  };
  // Upstream integer/natural use rounding, not floor. Even an equal-bound
  // explicit range consumes its random draw before handler dispatch.
  const integer = (min, max) => round(random() * (max - min)) + min;
  const parse = (name) => {
    const match = apply(exec, pattern, [name]);
    if (!match) return { name, ruled: false, count: 0, pick: false };
    const min = number(match[2]),
      hasMax = match[3] !== undefined;
    return {
      name: match[1],
      ruled: true,
      count: hasMax ? integer(min, number(match[3])) : min,
      pick: min === 1 && !hasMax,
    };
  };
  const generate = (template, name) => {
    const rule = parse(name);
    if (array(template)) {
      const result = [];
      // Parser draws above must not move below this early empty-array return.
      if (template.length === 0) return result;
      if (rule.pick) {
        // Upstream first materializes every candidate, including nested rules,
        // then Random.pick uses natural(0, length - 1), even for one candidate.
        const candidates = generate(template, "");
        return candidates[integer(0, candidates.length - 1)];
      }
      const count = rule.ruled ? rule.count : 1;
      for (let repeat = 0; repeat < count; repeat++)
        for (let index = 0; index < template.length; index++)
          set(result, result.length, generate(template[index], ""));
      return result;
    }
    if (template !== null && typeof template === "object") {
      const result = create(objectPrototype),
        keys = ownKeys(template);
      // Facade input is a null-prototype, own-enumerable-string-only clone.
      // ownKeys order equals upstream for-in order for exactly that domain.
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        // Projection itself must not parse/draw: each property rule is parsed
        // exactly once, inside generate, in upstream property order.
        const match = apply(exec, pattern, [key]);
        set(result, match ? match[1] : key, generate(template[key], key));
      }
      return result;
    }
    if (typeof template === "number" && rule.ruled) return rule.count;
    return template;
  };
  return (template) => generate(template, "");
}
