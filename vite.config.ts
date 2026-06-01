import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  clearScreen: false,

  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        pet: resolve(__dirname, "pet.html"),
      },
    },
  },

  server: {
    port: 1421,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
