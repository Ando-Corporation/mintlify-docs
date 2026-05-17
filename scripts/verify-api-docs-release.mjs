#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const siteUrl = process.env.ANDO_DOCS_URL ?? "https://docs.ando.so";
const latestOpenApiFile = "openapi-public-api-v1-latest.json";
const openApiAliasFiles = ["openapi.json", "api-reference/openapi.json"];
const datedOpenApiPattern = /openapi-public-api-v1-\d{4}-\d{2}-\d{2}\.json/g;

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

const parseJson = (label, text) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
};

const findDatedOpenApiFile = (label, text) => {
  const matches = [...text.matchAll(datedOpenApiPattern)].map((match) => match[0]);
  const uniqueMatches = [...new Set(matches)];
  if (uniqueMatches.length !== 1) {
    throw new Error(
      `${label} must link exactly one dated OpenAPI archive; found ${uniqueMatches.length}.`
    );
  }
  return uniqueMatches[0];
};

const collectOpenApiConfigValues = (value, results = []) => {
  if (Array.isArray(value)) {
    for (const item of value) collectOpenApiConfigValues(item, results);
    return results;
  }
  if (value == null || typeof value !== "object") {
    return results;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "openapi" && typeof nestedValue === "string") {
      results.push(nestedValue);
    }
    collectOpenApiConfigValues(nestedValue, results);
  }
  return results;
};

const checkDocsConfigOpenApiSource = () => {
  const docsConfig = JSON.parse(fileText("docs.json"));
  const values = collectOpenApiConfigValues(docsConfig);
  const unexpectedValues = values.filter(
    (value) => !openApiAliasFiles.includes(value)
  );
  const missingValues = openApiAliasFiles.filter(
    (value) => !values.includes(value)
  );
  if (values.length === 0) {
    throw new Error("docs.json must define OpenAPI sources.");
  }
  if (unexpectedValues.length !== 0 || missingValues.length !== 0) {
    throw new Error(
      `docs.json OpenAPI sources must use ${openApiAliasFiles.join(", ")}.`
    );
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
const publicApiIdentityTerms = [
  "Identity terms are narrower than storage table names",
  "Human user",
  "Agent",
  "Workspace member profile",
  "Principal",
  "Author",
  "API-key owner",
  "not as a separate public",
  "resource model",
];

const checkLocalArtifacts = () => {
  checkDocsConfigOpenApiSource();
  const beforeIndex = fileText("llms.txt");
  const openApiFile = findDatedOpenApiFile("llms.txt", beforeIndex);
  const before = {
    aliases: Object.fromEntries(
      openApiAliasFiles.map((aliasFile) => [aliasFile, fileText(aliasFile)])
    ),
    full: fileText("llms-full.txt"),
    index: beforeIndex,
    latestOpenApi: fileText(latestOpenApiFile),
  };

  run("node", ["scripts/build-llms.mjs"]);

  const after = {
    aliases: Object.fromEntries(
      openApiAliasFiles.map((aliasFile) => [aliasFile, fileText(aliasFile)])
    ),
    full: fileText("llms-full.txt"),
    index: fileText("llms.txt"),
    latestOpenApi: fileText(latestOpenApiFile),
  };
  const afterOpenApiFile = findDatedOpenApiFile("llms.txt", after.index);
  if (afterOpenApiFile !== openApiFile) {
    throw new Error(
      `dated OpenAPI archive changed from ${openApiFile} to ${afterOpenApiFile}.`
    );
  }
  if (
    JSON.stringify(before.aliases) !== JSON.stringify(after.aliases) ||
    before.full !== after.full ||
    before.index !== after.index ||
    before.latestOpenApi !== after.latestOpenApi
  ) {
    throw new Error(
      "generated docs artifacts were stale. Re-run node scripts/build-llms.mjs and commit the result."
    );
  }
  if (after.latestOpenApi !== fileText(openApiFile)) {
    throw new Error(`${latestOpenApiFile} does not match ${openApiFile}.`);
  }
  for (const aliasFile of openApiAliasFiles) {
    if (after.aliases[aliasFile] !== after.latestOpenApi) {
      throw new Error(`${aliasFile} does not match ${latestOpenApiFile}.`);
    }
  }

  assertIncludes("llms.txt", after.index, [
    "## Public API v1",
    "Search quickstart",
    latestOpenApiFile,
    openApiFile,
  ]);
  assertIncludes("llms-full.txt", after.full, [
    "Public API v1 uses `https://api.ando.so/v1`",
    "New integrations should send `x-api-key`",
    "Use Ando API keys from a server-side environment",
    "Use the stable messaging endpoints",
    ...publicApiIdentityTerms,
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
  const openApiFile = findDatedOpenApiFile("llms.txt", fileText("llms.txt"));
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
  const latestOpenApi = fileText(latestOpenApiFile);
  const sourceOpenApi = fs.readFileSync(monorepoOpenApi, "utf8");
  if (docsOpenApi !== sourceOpenApi) {
    throw new Error(
      `${openApiFile} does not match ${monorepoOpenApi}. Copy the regenerated spec into this repo.`
    );
  }
  if (latestOpenApi !== sourceOpenApi) {
    throw new Error(
      `${latestOpenApiFile} does not match ${monorepoOpenApi}. Re-run node scripts/build-llms.mjs.`
    );
  }
  for (const aliasFile of openApiAliasFiles) {
    if (fileText(aliasFile) !== sourceOpenApi) {
      throw new Error(
        `${aliasFile} does not match ${monorepoOpenApi}. Re-run node scripts/build-llms.mjs.`
      );
    }
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
    ...publicApiIdentityTerms,
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
  const openApiFile = findDatedOpenApiFile("/llms.txt", llmsIndex.text);
  assertIncludes("/llms.txt", llmsIndex.text, [
    "# Ando",
    "## Public API v1",
    "Search quickstart",
    latestOpenApiFile,
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
    ...publicApiIdentityTerms,
  ]);
  assertExcludes("/llms-full.txt", llmsFull.text, staleLlmsPhrases);

  const latestOpenApi = await fetchText(`/${latestOpenApiFile}`);
  const expectedOpenApiPhrases = [
    '"name": "x-api-key"',
    "legacy compatibility route kept for older clients",
    "nearly stable task-search route",
  ];
  const staleOpenApiPhrases = [
    "legacy frozen non-GA compatibility route",
    "GA-candidate search-extended route",
  ];
  assertIncludes(
    `/${latestOpenApiFile}`,
    latestOpenApi.text,
    expectedOpenApiPhrases
  );
  assertExcludes(`/${latestOpenApiFile}`, latestOpenApi.text, staleOpenApiPhrases);

  const openApi = await fetchText(`/${openApiFile}`);
  if (openApi.text !== latestOpenApi.text) {
    throw new Error(`/${openApiFile} does not match /${latestOpenApiFile}.`);
  }
  const latestOpenApiJson = parseJson(`/${latestOpenApiFile}`, latestOpenApi.text);
  const latestOpenApiPaths = Object.keys(latestOpenApiJson.paths ?? {}).sort();

  const aliasPaths = openApiAliasFiles.map((aliasFile) => `/${aliasFile}`);
  for (const aliasPath of aliasPaths) {
    const alias = await fetchText(aliasPath);
    assertIncludes(aliasPath, alias.text, expectedOpenApiPhrases);
    assertExcludes(aliasPath, alias.text, staleOpenApiPhrases);
    const aliasJson = parseJson(aliasPath, alias.text);
    const aliasOpenApiPaths = Object.keys(aliasJson.paths ?? {}).sort();
    if (JSON.stringify(aliasOpenApiPaths) !== JSON.stringify(latestOpenApiPaths)) {
      throw new Error(
        `${aliasPath} does not expose the same path set as /${latestOpenApiFile}.`
      );
    }
  }
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
