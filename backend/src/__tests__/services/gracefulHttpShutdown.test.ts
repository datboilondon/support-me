import { createServer } from "http";
import { closeHttpServer } from "../../services/gracefulHttpShutdown";

describe("closeHttpServer", () => {
  it("waits for an in-flight HTTP request to finish within the grace period", async () => {
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let responseFinished = false;
    const server = createServer((_req, res) => {
      markRequestStarted();
      res.on("finish", () => {
        responseFinished = true;
      });
      setTimeout(() => res.end("complete"), 25);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an IP server address");

    const responsePromise = fetch(`http://127.0.0.1:${address.port}`).then(async (response) => ({
      status: response.status,
      body: await response.text(),
    }));
    await requestStarted;

    await closeHttpServer(server, 1000);

    expect(responseFinished).toBe(true);
    await expect(responsePromise).resolves.toEqual({ status: 200, body: "complete" });
  });
});
