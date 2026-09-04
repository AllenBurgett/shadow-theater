// Zero-dependency dev launcher: runs the server and web dev servers together.
// Intentionally not `concurrently` — no dependency outside the ratified stack.
import { spawn, spawnSync } from "node:child_process";

const targets = [
  { label: "server", command: "npm run dev -w packages/server" },
  { label: "web", command: "npm run dev -w packages/web" },
];

const isWindows = process.platform === "win32";
const children = [];
let shuttingDown = false;

function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (isWindows) {
    // npm spawns a shell wrapper; `child.kill()` leaves the real dev server
    // running as a grandchild on Windows, so kill the whole tree.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    killChild(child);
  }
  process.exitCode = code ?? 0;
}

for (const target of targets) {
  // A single command string avoids DEP0190 (args + shell: true).
  const child = spawn(target.command, { shell: true, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev] ${target.label} exited (code=${code} signal=${signal}); stopping both.`);
      shutdown(code ?? 1);
    }
  });
  child.on("error", (err) => {
    console.error(`[dev] failed to start ${target.label}:`, err);
    shutdown(1);
  });
  children.push(child);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => shutdown(process.exitCode));
