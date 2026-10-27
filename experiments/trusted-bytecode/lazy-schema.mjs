import { createExperimentSession } from "./runtime.mjs";

// Installed before any guest code. Same production global/property contract,
// but no temporary source/factory/load-function global is ever created. Every
// getter calls the private zero-argument callback; the host owns its cache.
const installerSource = `(function(load){
  Object.defineProperty(globalThis,'__validateJSONSchema',{
    get:function(){return load();}
  });
})`;

export async function createLazySchemaSession(mode = "bytecode") {
  if (!["bytecode", "source"].includes(mode))
    throw Error("Unknown fixed schema mode");
  const session = await createExperimentSession();
  const { context, budget } = session;
  let state = "unloaded",
    cache,
    disposed = false,
    loads = 0,
    callbacks = 0;
  const fail = () => {
    state = "failed";
    cache?.dispose();
    cache = undefined;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      fail();
    } finally {
      session.dispose();
    }
  };
  let callback, installer, installed;
  try {
    budget.run("install-lazy-schema", () => {
      callback = context.newFunction("", (...args) => {
        let outgoing, candidate;
        try {
          budget.run("lazy-schema-callback", () => {
            callbacks++;
            if (disposed || args.length || state === "failed")
              throw Error("closed");
            if (state === "loading") {
              fail();
              throw Error("reentry");
            }
            if (state === "unloaded") {
              state = "loading";
              loads++;
              candidate = session.loadSchemaValue(mode);
              if (state !== "loading") throw Error("reentry");
              cache = candidate;
              candidate = undefined;
              state = "ready";
            }
            outgoing = cache.dup();
          });
          const transferred = outgoing;
          outgoing = undefined;
          // VmFunctionImplementation consumes this separate owned duplicate.
          // The cache owner is never returned or disposed by that transfer.
          return transferred;
        } catch {
          fail();
          return {
            error: context.newError({
              name: "Error",
              message: "Trusted lazy schema load failed",
            }),
          };
        } finally {
          outgoing?.dispose();
          candidate?.dispose();
        }
      });
      installer = context.unwrapResult(
        context.evalCode(
          installerSource,
          "localapi:trusted/lazy-schema-installer.js",
          { type: "global" },
        ),
      );
      installed = context.callFunction(installer, context.undefined, callback);
      if (installed.error)
        throw Error("Trusted lazy schema installation failed");
    });
  } catch (error) {
    // A partial, non-configurable getter must not survive failed installation.
    // Dispose its handles before disposing the context.
    (installed?.error || installed?.value)?.dispose();
    installed = undefined;
    installer?.dispose();
    installer = undefined;
    callback?.dispose();
    callback = undefined;
    dispose();
    throw error;
  } finally {
    (installed?.error || installed?.value)?.dispose();
    installer?.dispose();
    callback?.dispose();
  }
  return {
    ...session,
    dispose,
    // Host diagnostics only, never installed in a guest global or request API.
    lazy: Object.freeze({
      get state() {
        return state;
      },
      get loads() {
        return loads;
      },
      get callbacks() {
        return callbacks;
      },
    }),
  };
}
