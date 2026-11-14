import { copyFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const source = resolve("src/client/GitHubLoginButton.css")
const target = resolve("dist/client/GitHubLoginButton.css")

await mkdir(dirname(target), { recursive: true })
await copyFile(source, target)
