import { Server } from "http";

export default async function globalTeardown(): Promise<void> {
  const server: Server | undefined = (globalThis as any).__avoMockServer;
  if (server) {
    (globalThis as any).__avoMockServerClose();
    await new Promise((resolve) => server.close(resolve));
    // Setup created this server and the variable together. Clearing the variable lets the
    // next watch-mode run start a new server instead of reusing the closed port.
    delete process.env.AVO_INSPECTOR_MOCK_ENDPOINT;
    (globalThis as any).__avoMockServer = undefined;
    (globalThis as any).__avoMockServerClose = undefined;
  }
}
