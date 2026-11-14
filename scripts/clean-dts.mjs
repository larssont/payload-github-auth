// TypeScript preserves side-effect CSS imports in .d.ts files. Bundlers handle
// them, but Node type resolution (attw) cannot, so strip them from declarations.
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      await walk(path)
      continue
    }

    if (!entry.name.endsWith(".d.ts")) continue

    const source = await readFile(path, "utf8")
    const cleaned = source.replace(/^import\s+["'][^"']+\.css["'];?\n?/gm, "")

    if (cleaned !== source) await writeFile(path, cleaned)
  }
}

await walk("dist")
