import fs from "node:fs";
import path from "node:path";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

export class GameLogger {
  constructor({ enabled, dir, keepInMemory, includeRawLlmText, includeRedView, gameId, seed }) {
    this.enabled = !!enabled;
    this.dir = dir || "./logs";
    this.keepInMemory = typeof keepInMemory === "number" ? keepInMemory : 500;
    this.includeRawLlmText = includeRawLlmText !== false;
    this.includeRedView = includeRedView !== false;

    this.gameId = gameId;
    this.seed = seed;

    this.buffer = [];
    this.filePath = null;

    if (this.enabled) {
      ensureDir(this.dir);
      const file = `game-${safeName(seed)}-${safeName(gameId)}.jsonl`;
      this.filePath = path.resolve(this.dir, file);
      // Create file with header line (optional, still JSONL)
      const header = {
        ts: new Date().toISOString(),
        event: "game_start",
        gameId: this.gameId,
        seed: this.seed
      };
      fs.appendFileSync(this.filePath, JSON.stringify(header) + "\n", "utf8");
      this._push(header);
    }
  }

  _push(entry) {
    if (this.keepInMemory <= 0) return;
    this.buffer.push(entry);
    if (this.buffer.length > this.keepInMemory) this.buffer.splice(0, this.buffer.length - this.keepInMemory);
  }

  log(event, payload = {}) {
    if (!this.enabled) return;

    const entry = {
      ts: new Date().toISOString(),
      event,
      gameId: this.gameId,
      seed: this.seed,
      ...payload
    };

    // Respect config for potentially large fields
    if (!this.includeRawLlmText && entry.rawLlmText) delete entry.rawLlmText;
    if (!this.includeRedView && entry.redView) delete entry.redView;

    fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    this._push(entry);
  }

  tail(limit = 200) {
    const n = Math.max(0, Math.min(this.buffer.length, limit));
    return this.buffer.slice(this.buffer.length - n);
  }
}