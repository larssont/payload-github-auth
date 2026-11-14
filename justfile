set shell := ["bash", "-euo", "pipefail", "-c"]

# List available recipes.
[doc("List available recipes.")]
[group("Help")]
help:
    @just --list

# Install dependencies, create dev/.env, and generate the dev Payload files.
[doc("Install dependencies, create dev/.env if missing, and generate the dev Payload files.")]
[group("Setup")]
setup:
    pnpm install
    @if [ ! -f dev/.env ]; then cp dev/.env.example dev/.env; fi
    pnpm generate

# Start the dev app.
[doc("Start the dev app at http://localhost:3000.")]
[group("Develop")]
dev:
    @if [ ! -f dev/.env ]; then cp dev/.env.example dev/.env; fi
    @if [ ! -f dev/src/app/_payload/importMap.js ]; then pnpm generate; fi
    pnpm dev

# Biome, Knip, and tsc.
[doc("Run Biome, Knip, and tsc.")]
[group("Check")]
check:
    pnpm check
    pnpm lint:dead-code
    pnpm typecheck

# Apply Biome's safe fixes.
[doc("Apply Biome's safe lint, format, and import fixes.")]
[group("Check")]
fix:
    pnpm check:fix

# Unit tests; pass a file or pattern.
[doc("Run unit tests. Pass a file or pattern to narrow the run.")]
[group("Test")]
test *args:
    pnpm test {{ args }}

# Integration tests; pass a file or pattern.
[doc("Run integration tests. Pass a file or pattern to narrow the run.")]
[group("Test")]
test-integration *args:
    pnpm test:integration {{ args }}

# Unit tests with coverage.
[doc("Run unit tests with coverage.")]
[group("Test")]
test-coverage:
    pnpm test:coverage

# Build the package.
[doc("Build the package into dist/.")]
[group("Build")]
build:
    pnpm build

# Build and check the packed package.
[doc("Build, then check the package with publint and attw.")]
[group("Build")]
package:
    pnpm build
    pnpm lint:package
    pnpm lint:types

# Regenerate the import map and types.
[doc("Regenerate the Payload import map and types.")]
[group("Build")]
generate:
    pnpm generate:importmap
    pnpm generate:types

# Remove build output.
[confirm("Remove dist/?")]
[doc("Remove build output.")]
[group("Build")]
clean:
    pnpm clean

# The checks CI runs.
[doc("Run the checks CI runs.")]
[group("CI")]
ci: check test-coverage test-integration package

# Publish to npm, tag the release, and push the tag.
[confirm("Publish @larssont/payload-github-auth to npm, tag the release, and push the tag?")]
[doc("Publish to npm, tag the release, and push the tag.")]
[group("Release")]
publish: release-check check test test-integration package
    @tmp=$(mktemp -d); \
      pnpm pack --pack-destination "$tmp" >/dev/null; \
      npm publish "$tmp"/*.tgz --access public --auth-type=web; \
      status=$?; \
      rm -rf "$tmp"; \
      exit $status
    @version=$(node -p "require('./package.json').version"); \
      git tag -a "v$version" -m "v$version"; \
      git push origin "v$version"

[private]
release-check:
    @if [ -n "$(git status --porcelain)" ]; then echo "Working tree is dirty; commit before publishing."; exit 1; fi
    @version=$(node -p "require('./package.json').version"); \
      if git rev-parse "v$version" >/dev/null 2>&1; then echo "Tag v$version already exists."; exit 1; fi
