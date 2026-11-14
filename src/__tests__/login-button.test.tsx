import { readFileSync } from "node:fs"

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { GitHubLoginButton } from "../client/GitHubLoginButton.js"

describe("GitHubLoginButton", () => {
  it("renders the default href and label", () => {
    const html = renderToStaticMarkup(<GitHubLoginButton />)

    expect(html).toContain('href="/api/users/oauth/github"')
    expect(html).toContain("Sign in with GitHub")
    expect(html).toContain("payload-github-login-button__icon")
  })

  it("honors a custom href", () => {
    const html = renderToStaticMarkup(<GitHubLoginButton href="/cms-api/users/oauth/github" />)

    expect(html).toContain('href="/cms-api/users/oauth/github"')
  })

  it("ships the button and dark-theme styles in a CSS file", () => {
    const css = readFileSync(new URL("../client/GitHubLoginButton.css", import.meta.url), "utf8")

    expect(css).toContain(".payload-github-login-button")
    expect(css).toContain('[data-theme="dark"] .payload-github-login-button')
    expect(css).toContain("background: #f0f6fc")
  })
})
