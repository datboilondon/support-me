import type { Server } from "http";

export function closeHttpServer(server: Server, gracePeriodMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const graceTimer = setTimeout(() => {
      server.closeIdleConnections();
      server.closeAllConnections();
    }, gracePeriodMs);

    server.close((error) => {
      clearTimeout(graceTimer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
