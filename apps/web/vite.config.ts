/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Same-origin in dev: the refresh cookie stays SameSite=strict and no CORS is needed.
  server: { proxy: { "/api": "http://localhost:4000" } },
  build: {
    rolldownOptions: {
      output: {
        advancedChunks: { groups: [{ name: "react", test: /node_modules[\\/](react|react-dom|react-router|scheduler)/ }] },
      },
    },
  },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"] },
});
