import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// React Compiler ON, pinned (research R9); the oxc transform runs via the
// exactly-pinned optional peer `oxc-transform-react`.
export default defineConfig({
  plugins: [react({ compiler: true }), tailwindcss()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        // The server Host allowlist (research R7) accepts `127.0.0.1:3000`,
        // so the proxied request must carry the target's Host, not the dev
        // server's `127.0.0.1:5173`.
        changeOrigin: true,
      },
    },
  },
});
