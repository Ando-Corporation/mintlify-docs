#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const siteUrl = process.env.ANDO_DOCS_URL ?? "https://docs.ando.so";
const openApiFile = "openapi-public-api-v1-2026-05-17.json";

const args = process.argv.slice(2);

const usage = () => {
  console.log(`Usage:
  node scripts/verify-api-docs-release.mjs [--local] [--production] [--all] [--monorepo <path>]

Modes:
  --local       Rebuild llms artifacts, validate Mintlify, check links, and run diff hygiene.
  --production  Probe live docs. Uses ANDO_DOCS_URL when set, otherwise https://docs.ando.so.
  --all         Run local and production checks.
  --monorepo    Also run public OpenAPI contract checks in the Ando monorepo and compare specs.

Default: --local`);
};

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const flag = (name) => args.includes(name);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
};

const runLocal = flag("--all") || flag("--local") || (
  !flag("--production") && valueAfter("--monorepo") == null
);
const runProduction = flag("--all") || flag("--production");
const monorepoDir = valueAfter("--monorepo");

const fileText = (relativePath) =>
  fs.readFileSync(path.join(rootDir, relativePath), "utf8");

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? rootDir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed with exit ${result.status}`
    );
  }
};

const assertIncludes = (label, text, needles) => {
  for (const needle of needles) {
    if (!text.includes(needle)) {
      throw new Error(`${label} is missing expected text: ${needle}`);
    }
  }
};

const assertExcludes = (label, text, needles) => {
  for (const needle of needles) {
    if (text.includes(needle)) {
      throw new Error(`${label} contains stale text: ${needle}`);
    }
  }
};

const stalePublicApiPhrases = [
  "Public API v1 currently has two GA families",
  "bearer token header is preferred",
  "https://api.ando.so/conversations/conv_123/messages",
  "API keys are scoped to the workspace and member that created them",
  "legacy frozen non-GA compatibility route",
  "GA-candidate search-extended route",
];
const staleLlmsPhrases = [...stalePublicApiPhrases, "Documentation Index"];

const checkLocalArtifacts = () => {
  const before = {
    full: fileText("llms-full.txt"),
    index: fileText("llms.txt"),
  };

  run("node", ["scripts/build-llms.mjs"]);

  const after = {
    full: fileText("llms-full.txt"),
    index: fileText("llms.txt"),
  };
  if (before.full !== after.full || before.index !== after.index) {
    throw new Error(
      "llms artifacts were stale. Re-run node scripts/build-llms.mjs and commit the result."
    );
  }

  assertIncludes("llms.txt", after.index, [
    "## Public API v1",
    "Search quickstart",
    openApiFile,
  ]);
  assertIncludes("llms-full.txt", after.full, [
    "Public API v1 uses `https://api.ando.so/v1`",
    "New integrations should send `x-api-key`",
    "Use Ando API keys from a server-side environment",
    "Use the stable messaging endpoints",
  ]);
  assertExcludes("llms.txt", after.index, staleLlmsPhrases);
  assertExcludes("llms-full.txt", after.full, staleLlmsPhrases);
};

const checkLocalDocs = () => {
  checkLocalArtifacts();
  run("npx", ["--yes", "mint@4.2.566", "validate"]);
  run("npx", ["--yes", "mint@4.2.566", "broken-links"]);
  run("git", ["diff", "--check"]);
};

const checkMonorepoContracts = (monorepoPath) => {
  const resolved = path.resolve(monorepoPath);
  const monorepoOpenApi = path.join(
    resolved,
    "docs/api/public-api-v1.openapi.json"
  );
  if (!fs.existsSync(monorepoOpenApi)) {
    throw new Error(`Missing monorepo OpenAPI file: ${monorepoOpenApi}`);
  }

  run("corepack", ["pnpm", "run", "sync:public-api-openapi"], {
    cwd: resolved,
  });
  run("corepack", ["pnpm", "run", "check:public-api-openapi"], {
    cwd: resolved,
  });
  run(
    "corepack",
    ["pnpm", "--filter", "@ando/shared", "test", "--", "public-api-contracts.test.ts"],
    { cwd: resolved }
  );
  run("git", ["diff", "--check"], { cwd: resolved });

  const docsOpenApi = fileText(openApiFile);
  const sourceOpenApi = fs.readFileSync(monorepoOpenApi, "utf8");
  if (docsOpenApi !== sourceOpenApi) {
    throw new Error(
      `${openApiFile} does not match ${monorepoOpenApi}. Copy the regenerated spec into this repo.`
    );
  }
};

const fetchText = async (pathName) => {
  const response = await fetch(`${siteUrl}${pathName}`, {
    headers: { "cache-control": "no-cache" },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${pathName} returned ${response.status}`);
  }
  console.log(`${pathName} ${response.status} bytes=${text.length}`);
  return { response, text };
};

const checkProduction = async () => {
  const apiReference = await fetchText("/api-reference");
  if (!apiReference.response.url.endsWith("/api-reference/overview")) {
    throw new Error(
      `/api-reference redirected to ${apiReference.response.url}, expected /api-reference/overview`
    );
  }

  const overview = await fetchText("/api-reference/overview.md");
  assertIncludes("/api-reference/overview.md", overview.text, [
    "Use `x-api-key` as the canonical auth header",
    "**stable** means generally available",
  ]);
  assertExcludes(
    "/api-reference/overview.md",
    overview.text,
    stalePublicApiPhrases
  );

  const markdownPages = [
    "/api-reference/authorization.md",
    "/api-reference/messaging-quickstart.md",
    "/api-reference/http-api.md",
  ];
  for (const page of markdownPages) {
    const result = await fetchText(page);
    assertIncludes(page, result.text, ["x-api-key"]);
    assertExcludes(page, result.text, stalePublicApiPhrases);
  }

  const llmsIndex = await fetchText("/llms.txt");
  assertIncludes("/llms.txt", llmsIndex.text, [
    "# Ando",
    "## Public API v1",
    "Search quickstart",
    openApiFile,
  ]);
  assertExcludes("/llms.txt", llmsIndex.text, staleLlmsPhrases);

  const llmsFull = await fetchText("/llms-full.txt");
  assertIncludes("/llms-full.txt", llmsFull.text, [
    "Public API v1 uses `https://api.ando.so/v1`",
    "New integrations should send `x-api-key`",
    "Use Ando API keys from a server-side environment",
    "Use the stable messaging endpoints",
    "Searches tasks visible to the authenticated API key. This is a nearly stable task-search route",
  ]);
  assertExcludes("/llms-full.txt", llmsFull.text, staleLlmsPhrases);

  const openApi = await fetchText(`/${openApiFile}`);
  assertIncludes(`/${openApiFile}`, openApi.text, [
    '"name": "x-api-key"',
    "legacy compatibility route kept for older clients",
    "nearly stable task-search route",
  ]);
  assertExcludes(`/${openApiFile}`, openApi.text, [
    "legacy frozen non-GA compatibility route",
    "GA-candidate search-extended route",
  ]);
};

try {
  if (runLocal) {
    checkLocalDocs();
  }
  if (monorepoDir != null) {
    checkMonorepoContracts(monorepoDir);
  }
  if (runProduction) {
    await checkProduction();
  }
  console.log("API docs release verification passed.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
