import http from "node:http";
import net from "node:net";

/** A port nothing listens on (bind, read, release). */
export function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

export interface PlainServer {
  port: number;
  host: string;
  close(): Promise<void>;
}

/** A throwaway HTTP server on loopback (for "not a de-esp32 device" cases). */
export function startPlainServer(handler: http.RequestListener): Promise<PlainServer> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    const sockets = new Set<net.Socket>();
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        host: `127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            for (const s of sockets) s.destroy();
          }),
      });
    });
  });
}
