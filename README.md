# eleventy-bunny-sync

Manifest-based Eleventy 3 deployments to Bunny Storage and Bunny CDN. The
package observes the Eleventy build itself, so stale files left in `_site` are
never mistaken for current website output.

Only files owned by the previous remote manifest can be changed or deleted.
Files placed in the Storage Zone outside the manifest remain untouched.

## Requirements

- Node.js 22 or newer
- Eleventy 3
- A Bunny Storage Zone
- Optionally, a Bunny Pull Zone and account API key for CDN invalidation

Eleventy is a peer dependency: this package integrates with the Eleventy
installation belonging to your website rather than bundling its own copy.

## Install

```sh
npm install --save-dev @11ty/eleventy eleventy-bunny-sync
```

Add the manifest plugin to your Eleventy configuration:

```js
import eleventyBunnyManifest from 'eleventy-bunny-sync/eleventy';

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(eleventyBunnyManifest, {
    hashConcurrency: 8,
  });
}
```

The build always writes `.bunny-sync/manifest.json`. Add `.bunny-sync` to the
site repository's `.gitignore`.

The plugin uses `eleventy.after.results` for rendered output and Eleventy 3's
`eleventy.passthrough` destination-to-source map for passthrough files. It does
not scan `_site`. Manifests are generated for standalone `build` runs, not
`watch` or `serve` runs.

Add deployment scripts to the website's `package.json`:

```json
{
  "scripts": {
    "build": "eleventy",
    "deploy:bunny": "eleventy-bunny-sync",
    "deploy:bunny:check": "eleventy-bunny-sync --dry-run"
  }
}
```

## Configuration

Configuration is read from environment variables. Keep access keys out of
source control.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `BUNNY_STORAGE_ZONE_NAME` | yes | — | Storage Zone name |
| `BUNNY_ACCESS_KEY` | yes | — | Storage Zone password/access key |
| `BUNNY_STORAGE_REGION` | no | Frankfurt | `uk`, `ny`, `la`, `sg`, `se`, `br`, `jh`, `syd`, or blank/`de` |
| `BUNNY_STORAGE_PATH` | no | `/` | Destination directory inside the Storage Zone |
| `BUNNY_MAX_CONCURRENT_OPERATIONS` | no | `12` | Parallel uploads and parallel deletions |
| `BUNNY_MAX_ATTEMPTS` | no | `4` | Total attempts for retryable requests |
| `BUNNY_REQUEST_TIMEOUT_MS` | no | `120000` | Per-request timeout in milliseconds |
| `BUNNY_CDN_HOSTNAME` | no | — | Public Pull Zone hostname for exact-URL purges |
| `BUNNY_API_KEY` | with CDN hostname | — | Bunny account API key, not the Storage key |
| `BUNNY_PULL_ZONE_ID` | no | — | Numeric Pull Zone ID enabling full-zone purges |
| `BUNNY_FULL_PURGE_THRESHOLD` | no | `100` | URL count at which one full-zone purge is used |
| `BUNNY_MAX_CONCURRENT_PURGES` | no | `8` | Parallel exact-URL invalidations |

Local and remote manifests both use `.bunny-sync/manifest.json`. The remote
purge journal uses `.bunny-sync/purge-log.json`.

## Deploy

```sh
npm run build
npm run deploy:bunny -- --interactive
```

`--interactive` displays the current stage, elapsed time, active requests,
latest file path, and retry delays. It emits periodic lines when output is not
attached to a terminal, including in CI.

Use `--dry-run` or `--check` to compare manifests without modifying Bunny:

```sh
npm run build
npm run deploy:bunny:check
```

If the local manifest is missing, the command exits and asks you to run the
build. A missing remote manifest automatically starts a first deployment and
uploads every local manifest entry.

Uploads and deletes use bounded parallel worker pools. An already-missing
remote file is a warning, which allows interrupted deployments to resume.

After Storage succeeds, the deploy writes a pending purge journal and advances
the remote manifest before invalidating the CDN. Failed invalidations remain in
the journal and are retried by the next deployment, even when both manifests
already match. A no-change deployment still writes a completed journal entry
with an updated timestamp.

The remote manifest and purge journal URLs are invalidated whenever their
Storage objects are updated, so inspecting them through the CDN does not return
an older cached copy.

Targeted invalidations use `exactPath=true`. With `BUNNY_PULL_ZONE_ID`
configured, 100 or more affected URLs use one full Pull Zone purge by default.

## GitHub Actions

The package does not bundle Eleventy. A workflow installs the website's
dependencies, runs its Eleventy build, and then runs the deployment CLI:

```yaml
name: Deploy website

on:
  push:
    branches: [main]

concurrency:
  group: bunny-production
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npx eleventy-bunny-sync --interactive
        env:
          BUNNY_STORAGE_ZONE_NAME: ${{ vars.BUNNY_STORAGE_ZONE_NAME }}
          BUNNY_ACCESS_KEY: ${{ secrets.BUNNY_ACCESS_KEY }}
          BUNNY_STORAGE_REGION: ${{ vars.BUNNY_STORAGE_REGION }}
          BUNNY_STORAGE_PATH: ${{ vars.BUNNY_STORAGE_PATH }}
          BUNNY_CDN_HOSTNAME: ${{ vars.BUNNY_CDN_HOSTNAME }}
          BUNNY_API_KEY: ${{ secrets.BUNNY_API_KEY }}
          BUNNY_PULL_ZONE_ID: ${{ vars.BUNNY_PULL_ZONE_ID }}
```

Use a workflow concurrency group whenever multiple commits might deploy to the
same Storage Zone and path.

## Manifest format and ownership

The deterministic JSON manifest contains sorted entries of
`[path, sha256, size]`. The ignored local form adds a fourth source-path field
used for uploads. Comparisons use paths and SHA-256 hashes, never timestamps.

The synchronizer never lists the remote Storage Zone. Deletion candidates come
only from the previous remote manifest, so unmanifested remote files are left
alone.

## License

MIT
