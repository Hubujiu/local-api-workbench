// Internal WIP transport only. Not registered with HTTP/MCP/CLI or a default
// runSQLServerReadWIP factory. Importing/constructing does not open a socket.
import { Socket } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { Connection, Request, TYPES } from "tedious";
import {
  sqlServerConnectionContract,
  sqlServerResultTypeAllowed,
} from "./sqlserver-read-contract.mjs";

const failure = () => Error("SQL Server WIP transport failed");
function checkedConfig(config) {
  const expected = sqlServerConnectionContract({
    host: config?.server,
    user: config?.authentication?.options?.userName,
    password: config?.authentication?.options?.password,
    database: config?.options?.database,
    port: config?.options?.port,
    ssl: true,
    ...(config?.options?.cryptoCredentialsDetails?.ca === undefined
      ? {}
      : { ca: config.options.cryptoCredentialsDetails.ca }),
  });
  // Accept only the compiler's exact contract, not arbitrary driver options.
  if (!isDeepStrictEqual(config, expected)) throw failure();
  return expected;
}
function column(c) {
  let type = c?.type?.name;
  if (type === "IntN")
    type = { 1: "TinyInt", 2: "SmallInt", 4: "Int", 8: "BigInt" }[c.dataLength];
  if (type === "BitN" && c.dataLength === 1) type = "Bit";
  sqlServerResultTypeAllowed(type);
  if (
    ["Char", "VarChar", "NChar", "NVarChar", "Binary", "VarBinary"].includes(
      type,
    )
  ) {
    // MAX uses 0xffff and PLP buffering. Reject it, plus legacy LOB types,
    // rather than setting TEXTSIZE and silently truncating an individual value.
    if (
      !Number.isInteger(c.dataLength) ||
      c.dataLength < 1 ||
      c.dataLength > 8000
    )
      throw failure();
    if ((type === "NChar" || type === "NVarChar") && c.dataLength % 2)
      throw failure();
    // Tedious falls back to UTF-8 for an unrecognised non-Unicode codepage.
    if ((type === "Char" || type === "VarChar") && !c.collation?.codepage)
      throw failure();
  }
  return { name: c.colName, type };
}

// The only test seam is the two Tedious classes. Real TYPES are always used.
export function createTediousSQLServerPort(
  config,
  classes = { Connection, Request },
) {
  const safe = checkedConfig(config);
  let connection,
    socket,
    connectorUsed = false,
    stopped = false,
    ended = false,
    socketClosed = true,
    bad = false,
    connected = false,
    connectStarted = false,
    secure = false,
    databaseConfirmed = false,
    active,
    pendingConnect,
    pendingSocket,
    closeTimer,
    connectTimer,
    resolveClosed,
    rejectClosed;
  const closed = new Promise((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // Observe early failures even if the consumer hasn't attached its await yet.
  closed.catch(() => {});
  const settleClosed = () => {
    if (!ended || !socketClosed) return;
    clearTimeout(closeTimer);
    if (bad) rejectClosed(failure());
    else resolveClosed();
  };
  const destroy = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(connectTimer);
    pendingConnect?.(failure());
    pendingSocket?.(failure());
    const request = active?.request;
    active?.finish(failure());
    // Do not wait for ATTENTION acknowledgement before force-closing our socket.
    try {
      request?.cancel();
    } catch {
      bad = true;
    }
    closeTimer = setTimeout(() => rejectClosed(failure()), 2500);
    try {
      connection.close();
    } catch {
      bad = true;
    }
    try {
      socket?.destroy();
    } catch {
      bad = true;
    }
    settleClosed();
  };
  const fail = () => {
    bad = true;
    destroy();
    settleClosed();
  };
  const connector = () => {
    // Tedious also calls the connector after server routing / transient retry.
    // A second call is rejected BEFORE allocation or DNS/network. Ignore any
    // driver-provided reroute target; the first socket uses only the fixed host.
    if (connectorUsed || stopped) {
      fail();
      return Promise.reject(failure());
    }
    connectorUsed = true;
    socket = new Socket();
    socketClosed = false;
    socket.on("error", fail);
    socket.once("close", () => {
      socketClosed = true;
      if (!stopped) fail();
      settleClosed();
    });
    return new Promise((resolve, reject) => {
      let finished = false;
      pendingSocket = (error) => {
        if (finished) return;
        finished = true;
        pendingSocket = undefined;
        if (error || stopped) reject(failure());
        else resolve(socket);
      };
      socket.once("connect", () => pendingSocket?.());
      try {
        // Disable Node's family autoselection: one socket / one address attempt,
        // not fallback across addresses or a driver-managed pool.
        socket.connect({
          host: safe.server,
          port: safe.options.port,
          autoSelectFamily: false,
        });
      } catch {
        fail();
      }
    });
  };
  try {
    connection = new classes.Connection({
      ...safe,
      options: {
        ...safe.options,
        connector,
        serverName: safe.server,
        cryptoCredentialsDetails: {
          ...safe.options.cryptoCredentialsDetails,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
        },
        fallbackToDefaultDb: false,
        multiSubnetFailover: false,
        readOnlyIntent: false, // Routing hint is NOT a read-only security boundary.
        useColumnNames: false,
        cancelTimeout: 1000,
        appName: "Local API SQLServer WIP",
        workstationId: "Local API",
      },
    });
  } catch {
    throw failure();
  }
  connection.on("error", fail);
  connection.on("errorMessage", fail);
  connection.on("retry", fail);
  connection.on("rerouting", fail);
  connection.on("databaseChange", (name) => {
    if (name !== safe.options.database) fail();
    else databaseConfirmed = true;
  });
  connection.on("secure", (tlsSocket) => {
    if (stopped || tlsSocket?.authorized !== true) fail();
    else secure = true;
  });
  connection.on("end", () => {
    ended = true;
    if (!stopped) fail();
    settleClosed();
  });
  return {
    closed,
    destroy,
    connect() {
      if (connectStarted || stopped) return Promise.reject(failure());
      connectStarted = true;
      return new Promise((resolve, reject) => {
        let finished = false;
        pendingConnect = (error) => {
          if (finished) return;
          finished = true;
          pendingConnect = undefined;
          clearTimeout(connectTimer);
          if (
            error ||
            stopped ||
            !secure ||
            !databaseConfirmed ||
            !connectorUsed ||
            socketClosed
          ) {
            reject(failure());
            fail();
          } else {
            connected = true;
            resolve();
          }
        };
        connectTimer = setTimeout(fail, 3000);
        try {
          connection.connect((error) => pendingConnect?.(error));
        } catch {
          fail();
        }
      });
    },
    query(plan, sink) {
      if (!connected || stopped || active) return Promise.reject(failure());
      return new Promise((resolve, reject) => {
        let request,
          done = false,
          metadata,
          rowCount = 0,
          timer;
        const finish = (error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          active = undefined;
          if (error || stopped || !metadata) reject(failure());
          else resolve();
        };
        const guard =
          (fn) =>
          (...args) => {
            if (done || stopped) return;
            try {
              fn(...args);
            } catch {
              fail();
            }
          };
        try {
          request = new classes.Request(plan.sql, (error) => {
            if (done) return;
            if (error || !metadata) fail();
            else finish();
          });
          active = { request, finish };
          request.on("error", () => {
            if (!stopped) fail();
          });
          request.on(
            "columnMetadata",
            guard((columns) => {
              if (
                metadata ||
                !Array.isArray(columns) ||
                !columns.length ||
                columns.length > 128
              )
                throw failure();
              metadata = columns.map(column);
              sink.metadata(metadata);
            }),
          );
          request.on(
            "row",
            guard((columns) => {
              if (
                !metadata ||
                !Array.isArray(columns) ||
                columns.length !== metadata.length ||
                ++rowCount > 1001
              )
                throw failure();
              // Verify each row's metadata agrees with the accepted result set.
              const values = columns.map((c, i) => {
                if (!isDeepStrictEqual(column(c.metadata), metadata[i]))
                  throw failure();
                return c.value;
              });
              sink.row(values);
            }),
          );
          // execSql uses sp_executesql, so doneInProc(more=true) can precede
          // doneProc without a second result set. Count metadata, not DONE tokens.
          request.on("returnValue", () => {
            if (!done) fail();
          });
          for (const p of plan.parameters) {
            if (
              !/^p\d+$/.test(p.name) ||
              !["NVarChar", "Int", "BigInt", "Bit"].includes(p.type)
            )
              throw failure();
            request.addParameter(p.name, TYPES[p.type], p.value);
          }
          request.setTimeout(2000);
          timer = setTimeout(fail, 2000);
          connection.execSql(request);
        } catch {
          if (!active) {
            reject(failure());
          }
          fail();
        }
      });
    },
  };
}
