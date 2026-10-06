import { Server } from "http";

export default async function globalTeardown(): Promise<void> {
  const server: Server | undefined = (globalThis as any).__avoMockServer;
  if (server) {
    (globalThis as any).__avoMockServerClose();
    await new Promise((resolve) => server.close(resolve));
  }
}
