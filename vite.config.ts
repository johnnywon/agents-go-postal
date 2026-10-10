// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// A deployment kept in another repo can point at its own Wrangler config and
// public/ folder (brand files) without copying them into this checkout.
const wranglerConfig = process.env.AGP_WRANGLER_CONFIG;
const publicDir = process.env.AGP_PUBLIC_DIR;

export default defineConfig({
  publicDir: publicDir ? resolve(publicDir) : "public",
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      configPath: wranglerConfig ? resolve(wranglerConfig) : undefined,
    }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
