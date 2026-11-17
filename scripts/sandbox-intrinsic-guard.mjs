// Libraries run in the user's existing QuickJS realm, not a privileged host
// callback. Refuse changed intrinsics instead of freezing/restoring user state.
export function intrinsicGuard() {
  const descriptor = Object.getOwnPropertyDescriptor,
    hasOwn = Object.hasOwn,
    prototype = Object.getPrototypeOf,
    keys = Reflect.ownKeys,
    same = Object.is,
    root = globalThis,
    rootParent = Object.getPrototypeOf(globalThis);
  const names = [
    "globalThis",
    "Object",
    "Function",
    "Array",
    "String",
    "Number",
    "Boolean",
    "RegExp",
    "Symbol",
    "Math",
    "Reflect",
    "JSON",
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "URIError",
    "EvalError",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Date",
    "Promise",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "NaN",
    "Infinity",
    "undefined",
    "document",
    "window",
    "navigator",
    "java",
    "Node",
    "DOMParser",
    "XMLSerializer",
    "XPathResult",
  ];
  const visited = new Set(),
    snapshots = [],
    bindings = [];
  const visit = (object) => {
    if (
      object === null ||
      (typeof object !== "object" && typeof object !== "function") ||
      visited.has(object)
    )
      return;
    visited.add(object);
    const own = keys(object),
      entries = [];
    snapshots.push({ object, own, entries, parent: prototype(object) });
    visit(prototype(object));
    for (let at = 0; at < own.length; at++) {
      const property = descriptor(object, own[at]);
      entries.push(property);
      // Native descriptor records have own data fields. Test ownership before
      // reading so inherited properties never participate in the snapshot.
      for (const field of ["value", "get", "set"])
        if (hasOwn(property, field)) visit(property[field]);
    }
  };
  visit(rootParent);
  // Iterator prototypes are not constructor properties; capture their chains too.
  visit(prototype([][Symbol.iterator]()));
  visit(prototype(""[Symbol.iterator]()));
  visit(prototype(new Map()[Symbol.iterator]()));
  visit(prototype(new Set()[Symbol.iterator]()));
  for (const name of names) {
    const property = descriptor(root, name);
    bindings.push(property);
    // Do not traverse globalThis's arbitrary application state.
    if (property && name !== "globalThis") {
      // Native descriptor records have own data fields. Test ownership before
      // reading so inherited properties never participate in the snapshot.
      for (const field of ["value", "get", "set"])
        if (hasOwn(property, field)) visit(property[field]);
    }
  }
  const equal = (current, initial) => {
    if (!current || !initial) return current === initial;
    // The captured native descriptor function creates own enumerable/configurable
    // fields and exactly one complete data or accessor shape. Check that shape
    // before reading its own fields; never read absent fields through a poisoned
    // prototype. This preserves every comparison without twelve ownership calls
    // per descriptor on every XML task's complete intrinsic-graph walk.
    if (
      current.enumerable !== initial.enumerable ||
      current.configurable !== initial.configurable
    )
      return false;
    const data = hasOwn(current, "value");
    if (data !== hasOwn(initial, "value")) return false;
    return data
      ? current.writable === initial.writable &&
          same(current.value, initial.value)
      : same(current.get, initial.get) && same(current.set, initial.set);
  };
  return () => {
    // No user-replaceable method, iterator or getter is invoked by this check.
    // A primitive failure avoids constructing an Error from changed prototypes.
    if (prototype(root) !== rootParent)
      throw "pickVars XML内建对象已被脚本修改";
    for (let at = 0; at < names.length; at++)
      if (!equal(descriptor(root, names[at]), bindings[at]))
        throw "pickVars XML内建对象已被脚本修改";
    for (let at = 0; at < snapshots.length; at++) {
      const initial = snapshots[at],
        own = keys(initial.object);
      if (
        prototype(initial.object) !== initial.parent ||
        own.length !== initial.own.length
      )
        throw "pickVars XML内建对象已被脚本修改";
      for (let key = 0; key < own.length; key++)
        if (
          own[key] !== initial.own[key] ||
          !equal(descriptor(initial.object, own[key]), initial.entries[key])
        )
          throw "pickVars XML内建对象已被脚本修改";
    }
  };
}
