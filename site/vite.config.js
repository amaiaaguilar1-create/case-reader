import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.BASE || "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  worker: { format: "es" },
  test: {
    environment: "node",
    include: ["test/**/*.test.js"],
  },
});
