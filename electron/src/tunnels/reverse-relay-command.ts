import type { RemoteAccessConfig } from "@runweave/shared/tunnels";

/** An owned TCP relay; stdin heartbeat bounds cleanup after SSH/network loss. */
export function reverseRelayCommand(config: RemoteAccessConfig, remotePort: number, connectionLimit?: number): string {
    const program = `
      const net = require("node:net");
      let last = Date.now();
      const sockets = new Set();
      const server = net.createServer(client => {
        ${connectionLimit ? `if (sockets.size >= ${connectionLimit * 2}) { client.destroy(); return; }` : ""}
        const upstream = net.connect(${remotePort}, "127.0.0.1");
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
        }
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
        client.pipe(upstream).pipe(client);
      });
      const stop = () => {
        for (const socket of sockets) socket.destroy();
        server.close();
        process.exit(0);
      };
      process.stdin.on("data", () => last = Date.now());
      process.stdin.on("end", stop);
      process.on("SIGTERM", stop);
      process.on("SIGHUP", stop);
      setInterval(() => { if (Date.now() - last > 45000) stop(); }, 5000);
      server.on("error", error => { console.error(error.code); process.exit(1); });
      server.listen(${config.port}, ${JSON.stringify(config.listenAddress)},
        () => console.log("runweave-tunnel-ready"));
    `;
    return `node -e '${program.replace(/'/g, "'\\''")}'`;
}
