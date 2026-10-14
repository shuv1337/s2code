import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.SHUV2CODE_MARKETING_URL?.trim() || undefined,
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
