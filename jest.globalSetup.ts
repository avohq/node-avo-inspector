// One local mock of the Avo API for the whole run, so tests exercise event spec validation
// without reaching real hosts: AVO_INSPECTOR_MOCK_ENDPOINT points every non-prod instance's
// track requests and spec fetches here. Spec fetches get a valid "no spec" answer; track
// requests are refused by closing the connection, as the closed port used before did.
// Workers inherit the variable; tests that need their own server set it themselves.
import { createServer, Server } from "http";
import { AddressInfo } from "net";
import { answerSpecFetch, trackConnections } from "./src/__tests__/constants";

export default async function globalSetup(): Promise<void> {
  if (process.env.AVO_INSPECTOR_MOCK_ENDPOINT) {
    return;
  }
  const server: Server = createServer((req, res) => {
    if (!answerSpecFetch(req, res)) {
      req.socket.destroy();
    }
  });
  (globalThis as any).__avoMockServerClose = trackConnections(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  (globalThis as any).__avoMockServer = server;
  process.env.AVO_INSPECTOR_MOCK_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
