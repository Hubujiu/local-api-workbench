// Expected shape at the existing project-files.mjs JSON storage boundary.
// Never normalize the actual readback: a missing/changed defined value must fail.
export const storedJSON = (expected) => JSON.parse(JSON.stringify(expected));
