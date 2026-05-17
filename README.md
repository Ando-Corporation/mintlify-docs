# Ando Docs

This repository contains the Mintlify documentation site for Ando.

## Local development

Install the Mintlify CLI, then run the preview server from this directory:

```bash
npm i -g mint
mint dev
```

Useful checks:

```bash
mint validate
mint broken-links
mint a11y
```

## API docs release verification

Before publishing public API docs, run the repeatable release checks from this
repo:

```bash
node scripts/build-llms.mjs
node scripts/verify-api-docs-release.mjs --local
```

`--local` rebuilds `llms.txt` and `llms-full.txt`, verifies they were already
fresh, runs Mintlify validation, checks broken links, and runs `git diff
--check`.

If the versioned OpenAPI file changed, validate the source contract in the Ando
monorepo and confirm this repo's copied spec matches it:

```bash
node scripts/verify-api-docs-release.mjs --monorepo /Users/graemeboy/ando/ando
```

That runs:

```bash
corepack pnpm run sync:public-api-openapi
corepack pnpm run check:public-api-openapi
corepack pnpm --filter @ando/shared test -- public-api-contracts.test.ts
git diff --check
```

After Mintlify publishes to production, run:

```bash
node scripts/verify-api-docs-release.mjs --production
```

Production verification covers `/api-reference`, API markdown exports, the
versioned OpenAPI JSON, `llms.txt`, and `llms-full.txt`. It also checks for
stale API guidance such as bearer-preferred auth, the old create-message base
URL, old member-scoped API-key wording, and internal GA-candidate phrasing.

Use `--all` to run local and production checks together:

```bash
node scripts/verify-api-docs-release.mjs --all
```

Mintlify publish credentials do not belong in this repository. For local or
manual publishes, read `MINTLIFY_API_KEY` and `MINTLIFY_PROJECT_ID` from a
private shell environment or the monorepo's `.env.local`. For CI publish flows,
store the key as a GitHub Actions secret such as `MINTLIFY_API_KEY` and keep the
project id in a repository or organization secret/variable. Do not add Pulumi
or infra state just because a local Mintlify key exists; add infra ownership only
if Ando starts managing durable docs infrastructure there, such as the Mintlify
project, custom domain, webhooks, protected secret projection, or docs catalog
metadata.

## Content

- Product docs live in `docs/*.mdx`.
- Product updates live in `changelog.mdx`.
- Upcoming work lives in `coming-soon.mdx`.
- Changelog videos live in `videos/`.
