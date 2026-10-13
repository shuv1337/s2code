import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.T3CODE_MARKETING_URL,
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
