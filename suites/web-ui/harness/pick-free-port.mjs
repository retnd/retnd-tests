// Prints the first port at or after <start> that this machine will actually
// let a server bind, staying inside [floor, floor+slots).
//
// A separate process because playwright.config.ts is evaluated
// synchronously and binding a socket is not. One node start per run, not
// one per candidate port.
//
// "Free" here means free for a listener: the probe binds 127.0.0.1 with
// exclusive:true and closes again, which is the same syscall Vite is about
// to make. That leaves a window between the probe closing and Vite binding,
// which is why it is a courtesy and not the safety property. The safety
// property is Vite's own --strictPort plus reuseExistingServer:false: a run
// that loses the window fails to bind and says so, rather than reporting on
// a server it did not start.
import { createServer } from "node:net";

const [start, floor, slots] = process.argv.slice(2).map(Number);

function free(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

for (let i = 0; i < slots; i++) {
  const port = floor + ((start - floor + i) % slots);
  if (await free(port)) {
    process.stdout.write(String(port));
    process.exit(0);
  }
}

process.stderr.write(`no free port in [${floor}, ${floor + slots}) starting at ${start}\n`);
process.exit(1);
