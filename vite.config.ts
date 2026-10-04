import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// FlyKart is two pages that share one simulator: the original race lab (index.html)
// and FlyKart Vision (vision.html), which adds a camera, fusion and a lap memory.
export default defineConfig({
  server: { watch: { ignored: ["**/.cache/**"] } },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        vision: fileURLToPath(new URL("./vision.html", import.meta.url)),
        robot: fileURLToPath(new URL("./robot.html", import.meta.url)),
      },
    },
  },
});
