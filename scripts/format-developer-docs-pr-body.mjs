#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const defaultManifestPath = ".developer-docs/developer-docs-manifest.lock";

const usage = () => {
  console.log(`Usage:
  node scripts/format-developer-docs-pr-body.mjs [--manifest <path>] [--output <path>]

Formats a pull request body for generated developer docs sync updates.`);
};

const valueAfter = (args, option) => {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  return args[index + 1];
};

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const manifestPath = valueAfter(args, "--manifest") ?? defaultManifestPath;
const outputPath = valueAfter(args, "--output");
const resolvedManifestPath = path.resolve(rootDir, manifestPath);
const manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, "utf8"));
const artifactSha = (artifactPath) =>
  manifest.artifacts?.find((artifact) => artifact.path === artifactPath)
    ?.sha256 ?? "unknown";

const lines = [
  "## Summary",
  "- Sync generated developer docs artifacts from the Ando monorepo.",
  `- Source: ${manifest.source?.repository ?? "unknown"}@${manifest.source?.commit ?? "unknown"}.`,
  `- Generated at: ${manifest.generatedAt ?? "unknown"}.`,
  "",
  "## Artifact Counts",
  `- OpenAPI operations: ${manifest.openapi?.operationCount ?? "unknown"}.`,
  `- MCP public tools: ${manifest.inputs?.publicMcp?.publicToolCount ?? "unknown"}.`,
  `- MCP public API overlap tools: ${manifest.inputs?.publicMcp?.publicApiOverlapToolCount ?? "unknown"}.`,
  `- Webhook events: ${manifest.inputs?.webhookEvents?.eventCount ?? "unknown"}.`,
  "",
  "## Artifact Hashes",
  `- OpenAPI: \`${artifactSha("openapi-public-api-v1-latest.json")}\`.`,
  `- MCP public tools: \`${artifactSha("mcp-public-tools.json")}\`.`,
  `- MCP public tools MDX: \`${artifactSha("mcp-public-tools.mdx")}\`.`,
  `- Webhook events: \`${artifactSha("webhook-events.json")}\`.`,
  `- Webhook events MDX: \`${artifactSha("webhook-events.mdx")}\`.`,
  "",
  "## Commands",
  "```bash",
  "node scripts/sync-developer-docs.mjs --artifact-dir artifacts/developer-docs",
  "node scripts/build-llms.mjs",
  "node scripts/sync-developer-docs.mjs --artifact-dir artifacts/developer-docs --check",
  "node scripts/verify-api-docs-release.mjs --local",
  "npx --yes mint@4.2.566 validate",
  "npx --yes mint@4.2.566 broken-links",
  "npx --yes mint@4.2.566 a11y",
  "git diff --check",
  "```",
  "",
  "## Testing",
  "- `node scripts/sync-developer-docs.mjs --artifact-dir artifacts/developer-docs --check`",
  "- `node scripts/verify-api-docs-release.mjs --local`",
  "- `npx --yes mint@4.2.566 validate`",
  "- `npx --yes mint@4.2.566 broken-links`",
  "- `npx --yes mint@4.2.566 a11y`",
  "- `git diff --check`",
].join("\n");

if (outputPath == null) {
  console.log(lines);
} else {
  fs.writeFileSync(path.resolve(rootDir, outputPath), `${lines}\n`, "utf8");
}
