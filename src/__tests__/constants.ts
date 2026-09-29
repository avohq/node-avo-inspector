import { AvoInspectorEnv } from "../AvoInspectorEnv";

const defaultOptions = {
  apiKey: "api-key-xxx",
  env: AvoInspectorEnv.Dev,
  version: "1",
  shouldLog: true,
  appName: "my-test-app",
};

const error = {
  API_KEY:
    "[Avo Inspector] No API key provided. Inspector can't operate without API key.",
  VERSION:
    "[Avo Inspector] No version provided. Many features of Inspector rely on versioning. Please provide comparable string version, i.e. integer or semantic.",
};

const mockedReturns = {
  INSTALLATION_ID: "avo-instalation-id",
  GUID: "generated-guid",
  SESSION_ID: "session-id",
};

const networkCallType = {
  EVENT: "event",
  SESSION_STARTED: "sessionStarted",
};

const requestMsg = {
  ERROR: "Request failed",
  TIMEOUT: "Request timed out",
};

const trackingEndpoint = "https://api.avo.app/inspector/v2/track";

const sessionTimeMs = 5 * 60 * 1000;

const type = {
  STRING: "string",
  STRINGLIST: "list(string)",
  INT: "int",
  INTLIST: "list(int)",
  OBJECT: "object",
  OBJECTLIST: "list(object)",
  FLOAT: "float",
  FLOATLIST: "list(float)",
  BOOL: "boolean",
  BOOLLIST: "list(boolean)",
  NULL: "null",
  UNKNOWN: "unknown",
  UNKNOWNLIST: "list(unknown)",
};

// Restores an environment variable. Assigning undefined would store the string "undefined",
// so an originally absent variable is deleted instead.
const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

// Records a server's open sockets so a test can close them all on any Node version
// (server.closeAllConnections() needs Node 18.2; engines allows 14).
const trackConnections = (server: { on(event: "connection", cb: (socket: any) => void): unknown }) => {
  const sockets = new Set<any>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return () => sockets.forEach((socket) => socket.destroy());
};

export {
  restoreEnv,
  trackConnections,
  defaultOptions,
  error,
  mockedReturns,
  networkCallType,
  requestMsg,
  sessionTimeMs,
  type,
  trackingEndpoint,
};
