import { ENGINE_SCAFFOLD } from "@shadow/engine";

/**
 * `@shadow/server` scaffold entry point.
 *
 * Deliberately binds no port: the prototype (`npm start` → `server.js`) owns
 * :3000 until the legacy-removal PR. Routes, middleware and the Ollama
 * adapter land in issue #18.
 */
export function describeScaffold(): string {
  return `@shadow/server scaffold — routes land in issue #18 (engine linked: ${ENGINE_SCAFFOLD})`;
}

console.log(describeScaffold());
