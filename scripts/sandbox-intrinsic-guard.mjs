// Libraries run in the user's existing QuickJS realm, not a privileged host
// callback. Refuse changed intrinsics instead of freezing/restoring user state.
export function intrinsicGuard() {
  const descriptor = Object.getOwnPropertyDescriptor,
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
  const fields = [
    "value",
    "get",
    "set",
    "enumerable",
    "writable",
    "configurable",
  ];
  const visited = new Set(),
    snapshots = [],
    bindings = [];
  const visit = (object) => {
    if (
      object === null ||
      !["object", "function"].includes(typeof object) ||
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
      for (const field of ["value", "get", "set"]) {
        const part = descriptor(property, field);
        if (part) visit(part.value);
      }
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
      for (const field of ["value", "get", "set"]) {
        const part = descriptor(property, field);
        if (part) visit(part.value);
      }
    }
  }
  const equal = (current, initial) => {
    if (!current || !initial) return current === initial;
    for (let at = 0; at < fields.length; at++) {
      const a = descriptor(current, fields[at]),
        b = descriptor(initial, fields[at]);
      if (!a || !b) {
        if (a !== b) return false;
      } else if (!same(a.value, b.value)) return false;
    }
    return true;
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
