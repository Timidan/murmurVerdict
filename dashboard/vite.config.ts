import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname),
  resolve: {
    alias: {
      "@types": path.resolve(__dirname, "../src/types"),
    },
  },
  server: {
    port: 5173,
  },
});
