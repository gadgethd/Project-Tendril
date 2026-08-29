# Release process

Project Tendril releases are produced only by `.github/workflows/release.yml` from a `vX.Y.Z` tag whose commit is contained in `main`.

## Before tagging

1. Merge every intended change through a green pull request.
2. Set `package.json` to the release version and update `CHANGELOG.md` in a dedicated release pull request.
3. Run `TENDRIL_ALLOW_NO_SANDBOX=true npm run check` on a host where the native integration tests are allowed, then run the Docker smoke test without a no-sandbox override.
4. Confirm the package-consumer check contains no stale `dist` files and that dependency audit/signature checks pass.
5. Confirm the release commit is green on every required platform and CodeQL has no newly introduced high alert.

## Publish

Create an annotated tag matching `package.json`, then push that exact tag:

```bash
git tag -a vX.Y.Z -m "Project Tendril vX.Y.Z"
git push origin vX.Y.Z
```

The workflow verifies the tag, reruns all gates, creates the npm tarball, CycloneDX SBOM, checksums, GitHub artifact attestations, a GitHub release, and versioned GHCR images. npm publishing is enabled only when the repository variable `NPM_PUBLISH_ENABLED` is `true` and npm trusted publishing authorizes `release.yml`; it is deliberately skipped otherwise.

## Verify

- Download the tarball, SBOM, and checksums from the GitHub release and verify `sha256sum --check SHA256SUMS`.
- Verify artifact attestations with GitHub CLI.
- Install the tarball in a clean temporary project and compare `tendril --version` with the tag.
- Pull the exact GHCR semantic-version tag and repeat the authenticated container smoke test.
- Confirm the GitHub release is not empty and that package, CLI, MCP, health, OpenAPI, image labels, and changelog report the same version.

Do not move or reuse an existing release tag. If publishing fails after artifacts have become public, fix forward with a new patch version and document which surfaces were published.
