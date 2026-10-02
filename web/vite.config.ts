import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  base: "./",
  plugins: [preact()],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
  },
} as any);
