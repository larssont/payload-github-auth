import path from "node:path"
import { fileURLToPath } from "node:url"
import { withPayload } from "@payloadcms/tanstack-start"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import rsc from "@vitejs/plugin-rsc"
import { defineConfig } from "vite"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(
  withPayload(
    ({ pluginOptions }) => ({
      plugins: [rsc(pluginOptions.rsc), tanstackStart(pluginOptions.tanstackStart), viteReact(pluginOptions.react)],
      resolve: {
        alias: {
          "@/": `${path.resolve(__dirname, "src")}/`,
        },
      },
      server: {
        host: true,
        port: 3000,
      },
    }),
    { payloadConfigPath: path.resolve(__dirname, "src", "payload.config.ts") },
  ),
)
