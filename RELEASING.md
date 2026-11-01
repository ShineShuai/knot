# Releasing

Two copies run the same files:

| | beta | prod |
|---|---|---|
| host | GitHub Pages (`<user>.github.io/knot/`) | Cloudflare (custom domain) |
| deployed | every green push to `main` (`ci.yml`) | a tag `vX.Y.Z` (`release.yml`) |
| stamped | `channel=beta`, manifest "knot β" | `channel=prod`, `_headers` |

Both come from `tools/assemble.sh <out> <sha> <beta|prod>`; the same commit always gives the same
bytes, and beta and prod differ only in the channel stamp (a test checks that).

**Soak** is the time a build runs on beta before it may go to production: people use it for
real, and you see whether it breaks. It is the gate between "the tests passed" and "everyone
gets it". Here: at least 7 days on beta, no open `beta-blocker` issue, and the checklist below.

Beta and prod are different origins: identities, rooms, settings and installed apps are not
shared and nothing moves from one to the other. Testers start fresh on prod. Room links name the
origin they were made on.

## Release

1. `main` carries the next version (`package.json` and `src/version.js`, a test keeps them equal).
2. Let it run on beta. Work through the checklist on a real beta install, not a fresh one: the
   beta data survives deploys, so upgrading in place is part of the test.
   - [ ] pair two devices by code, and by room link
   - [ ] chat both ways, edit, react, delete; send a file and an image
   - [ ] audio and video call; screen share
   - [ ] reload and reopen: rooms and messages are still there
   - [ ] Settings > Diagnostics shows no unexpected recent errors
   - [ ] `/lab/lab.html` on the networks you care about
   - [ ] a room with a prod device in it (the current release) still works both ways
3. Anything wrong: open an issue, label it `beta-blocker`. Testers paste Settings > Diagnostics.
4. After 7 days with no blocker: `git tag v0.5.0 && git push origin v0.5.0`.
5. `release.yml` runs the gate, waits for approval of the `production` environment, deploys,
   smoke-tests the live site (build id, security headers, the live suite) and creates the GitHub
   release. Then bump `main` to the next version.

Wire and storage changes stay backward compatible for one release: old tabs and cached builds
share rooms with new ones, and beta users share rooms with prod users.

## Gate (`tools/release-gate.mjs`)

All of these, every problem listed: the tag is `v` + the version of `package.json` at that
commit; the commit is on `main` or `release/*`; `ci` passed on exactly that commit; its beta
deploy succeeded at least 7 days ago; no open `beta-blocker` issue. `force` skips only the soak.

## Hotfix and rollback

- Hotfix: fix on `main`, tag, and run `release` by hand (Actions > release > Run workflow) with
  `force`. If `main` holds work that has not soaked, branch `release/x.y` from the last tag,
  fix there, tag, and run it with `force` (the gate accepts `release/*`).
- Rollback: run `release` by hand with the previous tag and `force`. Open pages are told about
  the change like for any deploy; the next load is the old build.
- Try the gate alone: `dry_run`.

## One-time setup

Cloudflare:
1. The host name is `knot.vintoshine.com` (`deploy/cloudflare/wrangler.json`, `routes[0].pattern`;
   the release stops while it ends in `example.com`). The zone must be in the same account, and
   `knot` must not already have a DNS record: the first deploy creates it.
2. Create an API token from the "Edit Cloudflare Workers" template, limited to this account and
   zone. The first deploy creates the Worker `knot` and the DNS record.
3. For the app's host name: Rocket Loader off, Web Analytics auto-injection off (the CSP blocks
   it, and it is telemetry), no Bot Fight Mode or JS challenge (they break module and service
   worker requests), Always Use HTTPS on.
4. Do not use gradual deployments: the modules are not hashed, and a page could get files of two
   builds. Deploys must be atomic.

GitHub:
1. Settings > Environments > `production`: add yourself as required reviewer, and the secrets
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` there, so that only an approved job can
   read them. Required reviewers and environment secrets need a public repository, or a paid
   plan (reviewers: Enterprise for private ones). Without them, use repository secrets and let
   the tag be the approval.
2. Settings > Rules > Rulesets: only maintainers may create tags `v*`.
3. Create the label `beta-blocker`.
4. Settings > Pages > Source: GitHub Actions (already needed for beta).
5. Pin `cloudflare/wrangler-action` in `release.yml` to a commit id, and bump `wranglerVersion`
   on purpose.
6. Dry run: Actions > release > Run workflow with a tag, `dry_run`. Then the first real release.

## Not covered

- `github.io/<repo>/` shares its origin (and so IndexedDB) with every other Pages site of the
  account. Fine for test identities; if beta ever holds real chats, give it its own host name
  (`beta.<domain>`, DNS only) so that it has an origin of its own.
- The live suite loads the deployed pages with the service worker blocked. It does not test
  that the service worker installs and serves the app offline on the deployed host.
