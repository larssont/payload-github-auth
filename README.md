# Payload GitHub Auth

GitHub App login for the Payload CMS admin. The plugin adds a “Sign in with GitHub” button to the login page, verifies the user’s GitHub email, creates or links the Payload user, and mints a normal Payload session. It runs GitHub-only by default; set `allowPasswordLogin: true` to keep the local email/password strategy.

> Status: `0.1.0`, Payload 4 beta. ESM-only, Node `>=26.13.1`.

## What it does

- Adds a GitHub login button to the Payload admin login page.
- Uses a GitHub App user authorization flow with state and PKCE.
- Accepts only a verified GitHub email, preferring the primary address.
- Creates or links a Payload user from the GitHub identity.
- Requires an access rule: verified email, org, or `org/team-slug`.
- Assigns a required `defaultRole` and refuses `deniedRoles`.
- Installs a `github-jwt` session strategy with logout revocation and refresh extension.
- Sends a login notification email with the time, IP, and browser, never the token.
- Stores no GitHub access token and no password for GitHub-only users.
- Finishes the callback on a same-origin page before entering the admin, so Payload accepts the session cookie after the cross-site redirect from GitHub ([payloadcms/payload#16031](https://github.com/payloadcms/payload/issues/16031)).

## Requirements

- Payload 4 beta and React 19.
- Node `>=26.13.1`.
- An auth-enabled users collection with a singular `role` select field.
- A GitHub App.

The plugin expects `role` to be a single value, not a `roles` array. The configured `defaultRole` must be one of the field’s options.

## Install

```bash
pnpm add @larssont/payload-github-auth
```

After installing:

```bash
pnpm payload generate:importmap
pnpm payload generate:types
```

The plugin adds a login button component; the admin import map must include it. Import the button styles in the CSS file your admin already uses:

```css
@import "@larssont/payload-github-auth/client.css";
```

In production, create and run a Payload migration for the new `email`, `sessions`, and `github_id` fields. If you disable the local strategy, the same migration drops Payload’s password fields. In development, Payload’s schema push handles it.

## Quick start

```ts
import { buildConfig } from "payload"
import { githubAuthPlugin, parseAdminEmails } from "@larssont/payload-github-auth"

export default buildConfig({
  admin: { user: "users" },
  collections: [Users],
  plugins: [
    githubAuthPlugin({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      access: { email: parseAdminEmails(process.env.GITHUB_EMAILS) },
      defaultRole: "editor",
      serverUrl: process.env.PAYLOAD_PUBLIC_SERVER_URL!,
    }),
  ],
  serverURL: process.env.PAYLOAD_PUBLIC_SERVER_URL,
})
```

A minimal users collection:

```ts
import type { CollectionConfig } from "payload"

export const Users: CollectionConfig = {
  slug: "users",
  auth: true,
  fields: [
    {
      name: "role",
      type: "select",
      required: true,
      options: [
        { label: "Admin", value: "admin" },
        { label: "Editor", value: "editor" },
      ],
    },
  ],
}
```

The plugin adds the `email`, `sessions`, and `github_id` fields and installs the `github-jwt` strategy. The local email/password strategy is disabled unless `allowPasswordLogin: true`. When enabled, GitHub-created users receive a random password hash they never use; password login remains available for users who set a password.

## GitHub App

Create a GitHub **App**. Pick the prefilled registration link that matches your access rules; both set the name, homepage, `public=false`, and webhooks off:

- Email-only login: [Create the GitHub App](https://github.com/settings/apps/new?name=payload-github-auth&description=GitHub%20App%20login%20for%20the%20Payload%20CMS%20admin&url=https%3A%2F%2Fgithub.com%2Flarssont%2Fpayload-github-auth&public=false&webhook_active=false&emails=read)
- `org` or `team` rules: [Create the GitHub App with Members: Read](https://github.com/settings/apps/new?name=payload-github-auth&description=GitHub%20App%20login%20for%20the%20Payload%20CMS%20admin&url=https%3A%2F%2Fgithub.com%2Flarssont%2Fpayload-github-auth&public=false&webhook_active=false&emails=read&members=read)

Change the name if GitHub says it is taken. You still create the app, set its redirect URI, and generate the client secret yourself; the links only prefill the form.

<details>
<summary>Registration URLs</summary>

```text
# Email-only login
https://github.com/settings/apps/new?name=payload-github-auth&description=GitHub%20App%20login%20for%20the%20Payload%20CMS%20admin&url=https://github.com/larssont/payload-github-auth&public=false&webhook_active=false&emails=read

# org or team rules
https://github.com/settings/apps/new?name=payload-github-auth&description=GitHub%20App%20login%20for%20the%20Payload%20CMS%20admin&url=https://github.com/larssont/payload-github-auth&public=false&webhook_active=false&emails=read&members=read
```

</details>

Set the **Redirect URI** to your app's callback URL. The port depends on where Payload runs, so use your own:

```
<serverUrl>/api/<usersSlug>/oauth/github/callback
```

With the default `usersSlug`:

```
<serverUrl>/api/users/oauth/github/callback
```

GitHub Apps support up to 10 callback URLs, so add localhost alongside production:

```
http://localhost:3000/api/users/oauth/github/callback
```

Configure these permissions:

| Permission                | Level | When                                            |
| ------------------------- | ----- | ----------------------------------------------- |
| Account → Email addresses | Read  | Always; `/user/emails` needs it.                |
| Organization → Members    | Read  | Only when you use `org` or `team` access rules. |

Install the app on the account or organization:

- For email-only login, installation is not required for a user to authorize the app.
- For `org` or `team` rules, install the app on that organization with **Members: read**. The plugin uses the user access token to read `/user/orgs` and the team membership endpoint; the app must be installed on the org for that token to see it.
- If the app is “Only on this account”, it can only be installed on the account that owns it. Create it under the org, or allow installation on other accounts, if you need multiple orgs.

Generate a client secret and set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`; put the allowed addresses in `GITHUB_EMAILS` (or pass them directly to `access`). The plugin does not need the app’s private key; it uses the user authorization flow, not installation tokens.

**Expire user authorization tokens** does not affect the plugin. The token is used only during the callback and then discarded, so its lifetime never matters. The plugin sends `scope=offline_access`, which asks GitHub for an expiring token and a refresh token; it ignores the refresh token. Either setting works.

Webhooks are not used. You do not need a tunnel for local development; the GitHub authorization redirect goes straight to localhost.

## Access rules

`access` is required. It can be one rule, a shorthand list, or an explicit rule set:

```ts
// one rule
access: { email: parseAdminEmails(process.env.GITHUB_EMAILS) }

// any of these grants access (the shorthand defaults to match: "any")
access: [
  { email: parseAdminEmails(process.env.GITHUB_EMAILS) },
  { team: "acme/engineering" },
]

// both must pass
access: {
  match: "all",
  rules: [
    { email: (email) => email.endsWith("@acme.com") },
    { org: "acme" },
  ],
}
```

A rule is exactly one of:

| Rule        | Matches                                               |
| ----------- | ----------------------------------------------------- |
| `{ email }` | A verified GitHub email; a string list or a function. |
| `{ org }`   | An organization login; a string or string list.       |
| `{ team }`  | A team as `org/team-slug`; a string or string list.   |

`match` is `"any"` (default) or `"all"`. Rules are evaluated after a verified email is selected (the primary verified address is preferred) and before a user is created or linked. Org rules use `/user/orgs`. Team rules use `GET /orgs/{org}/teams/{team_slug}/memberships/{username}`, which includes inherited child-team membership; that is one request per configured team rule. The GitHub App must be installed on the org with **Members: read**.

Access is checked at login. An existing session is not re-checked when someone leaves an org or team; it survives until the session expires or is revoked. Use a short `tokenExpiration` and disable refresh if you need a short revocation window.

## Client IP

The rate limiter and the login notification email use `ipAddress`:

```ts
ipAddress: {
  headers: ["x-forwarded-for"], // read in order
  trustedProxies: [],           // CIDRs to skip in an XFF chain
  ipv6Subnet: 64,               // group IPv6 clients by /64
}
```

- A single-value header such as `x-real-ip` or `cf-connecting-ip` is used directly.
- For `x-forwarded-for`, the plugin walks the chain from the right and skips `trustedProxies`; the first untrusted address is the client.
- If the chain has multiple values and no `trustedProxies`, or no valid address is found, all clients share one rate-limit bucket (`"unknown"`).
- IPv4-mapped IPv6 is converted to IPv4. IPv6 rate-limit keys are masked to `ipv6Subnet`; `/64` is the default, `/56` for residential ISP allocations, `/128` only for controlled networks.

Railway (the edge overwrites `X-Real-IP`):

```ts
ipAddress: { headers: ["x-real-ip"], ipv6Subnet: 64 }
```

Railway behind Cloudflare:

```ts
ipAddress: { headers: ["cf-connecting-ip"], ipv6Subnet: 64 }
```

Self-hosted nginx with a static proxy CIDR:

```ts
ipAddress: { headers: ["x-forwarded-for"], trustedProxies: ["10.0.0.0/8"], ipv6Subnet: 64 }
```

Direct clients, no proxy:

```ts
ipAddress: {
  headers: []
} // one shared bucket
```

The plugin cannot read the socket address (Payload’s request is a web `Request`), so direct connections need a header set by your server or proxy if you want per-client limits.

## Options

| Option               | Type                           | Description                                                                                                                                           |
| -------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientId`           | `string`                       | GitHub App client ID.                                                                                                                                 |
| `clientSecret`       | `string`                       | GitHub App client secret.                                                                                                                             |
| `usersSlug`          | `string`                       | Auth collection slug. Defaults to `users`.                                                                                                            |
| `adminRoute`         | `string`                       | Admin route used for the login redirect and the completion page. Defaults to `config.routes.admin`, then `/admin`. Must be a path, not a URL.         |
| `serverUrl`          | `string`                       | Public CMS origin. Defaults to `config.serverURL`; one of them is required.                                                                           |
| `access`             | `GithubAccessConfig`           | Required. One rule, a list, or `{ match, rules }`. See above.                                                                                         |
| `defaultRole`        | `string`                       | Required. Role assigned to a new GitHub user.                                                                                                         |
| `deniedRoles`        | `string[]`                     | Roles refused for GitHub sign-in. Defaults to `[]`.                                                                                                   |
| `githubClient`       | `GithubClient`                 | Optional GitHub transport for tests or a custom HTTP client. Custom clients must implement `fetchTeamMembership` and return `login` from `fetchUser`. |
| `onLogin`            | `(event) => Promise<void>`     | Override the default login notification email.                                                                                                        |
| `ipAddress`          | `IpAddressOptions`             | Client IP source for rate limiting and the login email. Defaults to `headers: ["x-forwarded-for"]`, `trustedProxies: []`, `ipv6Subnet: 64`.           |
| `rateLimit`          | `{ windowMs?, max? } \| false` | Per-process login rate limit. Defaults to 10 requests per 15 minutes. Uses `ipAddress`.                                                               |
| `appName`            | `string`                       | Name used in the login email. Defaults to `CMS`.                                                                                                      |
| `allowPasswordLogin` | `boolean`                      | Keep the local email/password strategy. Defaults to `false`. When enabled, GitHub-created users get a random, unusable password hash.                 |

`access` has no development bypass. An empty rule set is rejected at boot, and `defaultRole` cannot be in `deniedRoles`.

## Access helpers

Payload has generic access control, but it has no built-in role system and does not know that this plugin uses a singular `role` field. `createGithubAuthAccess` is an optional convenience that encodes the plugin’s assumptions:

```ts
import { createGithubAuthAccess } from "@larssont/payload-github-auth"

const { adminOnly, adminField, selfOrAdmin } = createGithubAuthAccess({
  adminRole: "admin",
})
```

- `adminOnly` — collection-level `Access`; returns true only for admins. Use it for `create`/`delete` or an admin-only collection.
- `adminField` — field-level `FieldAccess`; returns true only for admins. Use it on `role` (and other sensitive fields) for `access.create`/`access.update`; non-admin writes are stripped. Add `access.read` if non-admins should not see the field.
- `selfOrAdmin` — collection-level `Access`; returns `{ id: { equals: req.user.id } }` for a signed-in non-admin, true for an admin, and false for anonymous. Use it on `read`/`update`/`delete`; not on `create`, which expects a boolean rather than a `where`.

Example:

```ts
export const Users: CollectionConfig = {
  slug: "users",
  auth: true,
  access: {
    read: selfOrAdmin,
    update: selfOrAdmin,
    create: adminOnly,
    delete: adminOnly,
  },
  fields: [
    {
      name: "role",
      type: "select",
      required: true,
      options: ["admin", "editor"],
      access: {
        create: adminField,
        update: adminField,
      },
    },
  ],
}
```

`selfOrAdmin` restricts which documents a user can touch, not which fields. Pair it with `adminField` on `role` and any other sensitive field such as `email`; otherwise a user can edit their own document's unprotected fields.

Why import it? It saves you from reimplementing the same checks and, more importantly, from forgetting to protect the `role` field. Without field-level protection, a user who can update their own profile may be able to change their role. The helpers are not required; write your own if you use a `roles` array or a different role model.

## Security

- Only a verified GitHub email is accepted; the primary verified address is preferred.
- Access rules are enforced before a user is created or linked.
- The session cookie is `HttpOnly`, `SameSite=Lax`, host-only, and `Secure` in production.
- The login button styles are a separate CSS file (`@larssont/payload-github-auth/client.css`), not an inline `<style>` tag, so a strict `style-src` can work if the rest of the admin does not need inline styles.
- The JWT is verified with HS256, Payload’s `authVersion`, and the Payload secret; the session id must still exist on the user.
- Logout revokes the current session; refresh extends it. `POST /api/<usersSlug>/logout?allSessions=true` clears every session for the user; the admin UI does not expose that flag, and the server-function logout path does not pass it.
- Every sign-in sends a notification email with the time, IP, and browser, never the token.
- If no trustworthy client IP is found, all clients share one rate-limit bucket rather than trusting a spoofable header.
- With `allowPasswordLogin: false` (the default), no password or hash is stored for GitHub users. With `true`, Payload’s local strategy requires a password on create; the plugin generates a random one and Payload stores only its hash, which the user never knows.
- A GitHub App uses fine-grained permissions (`Email addresses: read`, `Members: read`) instead of OAuth scopes. The plugin sends `offline_access` and discards the user token, and any refresh token, after login.
- Org and team membership is checked at login, not continuously. An existing session survives removal from the org or team until it expires.

Host responsibilities: use HTTPS, set a CSP and security headers, keep Payload and dependencies patched, protect `payload.secret` and the GitHub App client secret, enforce GitHub 2FA/org policy where needed, and protect the `role` field and users collection access.

## Limitations

- Org/team access is checked only at login; removing someone does not revoke an existing session.
- Team rules make one GitHub API request per configured team rule.
- An existing user with no `github_id` can be linked to a GitHub account with the same verified email. The relink guard protects users that already have a `github_id`.
- The session store writes the whole `sessions` array; concurrent login/logout can lose or revive a session. Payload’s own session helpers use the same pattern.
- The rate limiter is in-memory and per-process. Use one instance, a shared store, or proxy-level rate limiting for multiple instances.
- `allSessions=true` is honored on REST logout only; the admin UI does not expose it and the server-function path does not pass it.
- `allowPasswordLogin: true` keeps the password attack surface and stores a random hash for GitHub users.
- The plugin does not enable `__Host-` cookies; Payload shares `cookiePrefix` with its language cookie, which is not set with `Secure`.
- The plugin does not enforce GitHub 2FA or SAML SSO, and does not revoke the GitHub OAuth token at GitHub.
- Custom `GithubClient` implementations must implement `fetchTeamMembership` and return `login` from `fetchUser`.
- The package is ESM-only and assumes one users collection per app.

## Development

The recipes wrap `pnpm`; `just` is the task runner.

| Command                 | What it does                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `just setup`            | Install dependencies, create `dev/.env`, and generate dev files. |
| `just dev`              | Start the dev app at `http://localhost:3000`.                    |
| `just check`            | Run Biome, Knip, and `tsc`.                                      |
| `just fix`              | Apply Biome’s safe lint, format, and import fixes.               |
| `just test`             | Run unit tests. Pass a file or pattern to narrow the run.        |
| `just test-integration` | Run integration tests against a real Payload + SQLite instance.  |
| `just test-coverage`    | Run unit tests with coverage.                                    |
| `just build`            | Build the package into `dist/`.                                  |
| `just package`          | Build, then check the packed package with publint and attw.      |
| `just generate`         | Regenerate the Payload import map and types.                     |
| `just clean`            | Remove `dist/`.                                                  |
| `just ci`               | Run the checks CI runs.                                          |
| `just publish`          | Publish to npm, tag `v<version>`, and push the tag.              |

`just setup` and `just dev` create `dev/.env` from `dev/.env.example` and generate the Payload import map and types. The generated `_payload` files are not tracked; `payload-types.ts` and `routeTree.gen.ts` are tracked so `tsc` works on a fresh checkout.

Local development has no proxy, so the default `x-forwarded-for` header is absent and the rate limiter uses one shared bucket. The dev config sets `rateLimit: false`; set it back if you want to exercise the limiter locally.

Add the dev callback URL to the GitHub App:

```
http://localhost:3000/api/users/oauth/github/callback
```

`just publish` requires a clean working tree and an npm login. It runs the checks, publishes, tags `v<version>`, and pushes the tag.

## License

[MIT](LICENSE.md)
