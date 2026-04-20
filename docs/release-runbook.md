# Release Runbook

Automated via two GitHub Actions workflows. This doc explains the flow, the one-time setup, and what to do when something goes sideways.

## The flow (normal case)

```
make bump-patch          # 26.4.X → 26.4.X+1 in package.json
git commit -am "chore: bump to 26.4.X+1"
git push origin main
git tag -a vYY.MM.PATCH -m "release notes..."
git push origin vYY.MM.PATCH       ← here automation kicks in
```

Once the tag is pushed, `.github/workflows/release.yml` fires automatically:
1. Creates a **draft** GitHub Release with auto-generated notes.
2. Stops. Nothing else happens.

You then go to the GitHub Releases page, review the draft (edit the notes if needed), and click **Publish release**. That click triggers `.github/workflows/publish.yml`:
1. Checks out the tagged commit.
2. Verifies `package.json` version matches the tag.
3. Runs typecheck + tests.
4. Runs `npm publish --provenance` via OIDC.

Total time: ~2-3 minutes after you click Publish.

## One-time setup (required before first use)

### 1. Register this repo as a trusted publisher on npmjs.com

OIDC publishing needs npm to know this GitHub repo + workflow is allowed to publish the package. Without this the `npm publish` step fails with "403 Forbidden".

On https://www.npmjs.com/package/@jeikeilim/tenet/access (needs maintainer login):
1. Under **Trusted Publisher**, click "Add trusted publisher".
2. Fill in:
   - **Publisher**: GitHub Actions
   - **Organization or user**: `JeiKeiLim`
   - **Repository**: `tenet`
   - **Workflow filename**: `publish.yml`
   - **Environment name**: leave blank (we don't use deployment environments)
3. Save.

Docs: https://docs.npmjs.com/trusted-publishers

### 2. Nothing else needed

- No `NPM_TOKEN` in GitHub Actions secrets.
- No 2FA-per-publish hurdle (OIDC auth doesn't require 2FA for each publish).
- `GITHUB_TOKEN` is built-in; the release.yml workflow uses it to create the draft release.

## When things go wrong

### Tag pushed but no draft release appeared

Check the Actions tab on GitHub. The `Release` workflow run will show what failed. Common causes:
- Tag doesn't match `v*` pattern.
- `contents: write` permission missing (check workflow file).
- GH API rate-limiting (rare; retry).

### Clicked Publish but the npm publish workflow failed

Open the failed workflow run. Common failure modes:

| Failure message | Cause | Fix |
|---|---|---|
| "tag X does not match package.json version" | Forgot to bump before tagging | Delete the tag, bump, retag |
| `403 Forbidden` from npm | Trusted publisher not configured | Do the one-time setup above |
| Typecheck or test failed | Real bug snuck past local checks | Fix on main, retag |
| `npm ERR! code E404` on dependency | pnpm-lockfile drift | `pnpm install` + commit lockfile |

The **release itself stays published** on GitHub even if the npm step fails. You can re-trigger the publish workflow manually from the Actions UI (Re-run all jobs) after fixing the cause.

### Need to unpublish

npm's unpublish policy is restrictive:
- Within 72 hours of publish: you can unpublish.
- After 72 hours: you can only deprecate.

Commands:
```bash
npm unpublish @jeikeilim/tenet@26.4.X      # within 72h
npm deprecate @jeikeilim/tenet@26.4.X "reason"
```

Prefer bumping a patch and publishing a fix over unpublishing. Unpublish breaks anyone who's already installed.

### Need to publish manually (automation bypassed)

Original manual flow still works:

```bash
make check                  # typecheck + test
npm publish --access public # you'll need npm login beforehand
```

Useful when the repo is temporarily unable to use Actions (outage, credential issue, etc.).

## What's NOT automated

- **E2E canaries** (`make e2e-*`). They cost real money and are maintainer-discretion. Run before a release if the change is risky.
- **Lint** (`make lint`). eslint isn't currently in devDeps; the workflow skips it. Add eslint + re-enable the lint step if desired.
- **Version bump**. Still manual via `make bump-patch` or `make bump-month`. Intentional — we want the commit with the version change to be deliberate and reviewable.

## Verifying a successful release

After a publish completes, confirm:

1. `npm view @jeikeilim/tenet@YY.MM.PATCH` — the version exists on the registry.
2. The npm package page shows a **provenance** badge ("Built and signed on GitHub Actions").
3. `npx @jeikeilim/tenet@YY.MM.PATCH --version` in a throwaway shell prints the expected version.
4. The GitHub Release page shows as Published (not Draft).

If all four check out, the release is good.
