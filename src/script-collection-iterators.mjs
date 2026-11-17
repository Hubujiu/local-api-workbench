// Serialized into the existing VM; read supplies validated live-entry snapshots.
function installCollectionIterators({ collection, read, parent }) {
  const callback = (fn, context) => {
    if (typeof fn !== "function") throw Error("集合迭代需要函数");
    return (...args) => Reflect.apply(fn, context, args);
  };
  collection.each = (fn, context) => {
    const invoke = callback(fn, context || parent),
      rows = read();
    for (let i = 0; i < rows.length; i++)
      if (invoke(rows[i], i, rows) === false) break;
  };
  collection.map = (fn, context) =>
    read().map(callback(fn, context || collection));
  collection.filter = (fn, context) => read().filter(callback(fn, context));
  collection.find = (fn, context) => read().find(callback(fn, context));
  collection.reduce = (fn, initial, context) =>
    read().reduce(callback(fn, context || collection), initial);
}
export const collectionIteratorsSource = installCollectionIterators.toString();
