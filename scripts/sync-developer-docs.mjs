#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const defaultArtifactDir = "../ando/artifacts/developer-docs";
const latestOpenApiFile = "openapi-public-api-v1-latest.json";
const openApiAliasFiles = ["openapi.json", "api-reference/openapi.json"];
const manifestOutputFile = ".developer-docs/developer-docs-manifest.lock";
const mcpPublicToolsDataFile = ".developer-docs/mcp-public-tools.lock";
const mcpPublicToolsReferenceFile = "docs/ando-mcp-tools.mdx";
const webhookEventsDataFile = ".developer-docs/webhook-events.lock";
const webhookEventsReferenceFile = "api-reference/webhook-events.mdx";
const toolkitCodeSamplesDataFile = ".developer-docs/public-api-code-samples.lock";
const datedOpenApiPattern = /^openapi-public-api-v1-\d{4}-\d{2}-\d{2}\.json$/u;
const generatedLlmsFiles = [
  "api-reference/openapi.json",
  "llms-full.txt",
  "llms.txt",
  latestOpenApiFile,
  "openapi.json",
];

const requiredOperationIds = [
  "createWebhookEndpoint",
  "getWebhookEndpoint",
  "listWebhookDeliveries",
  "listWebhookEndpoints",
  "openRealtimeConnection",
  "replayWebhookDelivery",
  "rotateWebhookEndpointSecret",
  "sendWebhookEndpointTestEvent",
  "updateWebhookEndpoint",
];

const optionsWithValues = new Set([
  "--archive-date",
  "--artifact-dir",
  "--monorepo",
  "--openapi",
  "--toolkit",
]);

const usage = () => {
  console.log(`Usage:
  node scripts/sync-developer-docs.mjs [--artifact-dir <path>] [--monorepo <path>] [--openapi <path>] [--toolkit <path>] [--archive-date YYYY-MM-DD] [--check]

Copies generated developer docs artifacts from the Ando monorepo into the
Mintlify docs repo. Defaults to ../ando/artifacts/developer-docs. Toolkit code
samples are copied from <toolkit>/artifacts/docs/public-api-code-samples.json
when --toolkit is provided and the artifact exists.`);
};

const parseArgs = (rawArgs) => {
  const options = {};
  const flags = new Set();
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--check") {
      flags.add(arg);
      continue;
    }
    if (!optionsWithValues.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = rawArgs[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    options[arg] = value;
    index += 1;
  }
  if (
    options["--artifact-dir"] != null &&
    (options["--monorepo"] != null || options["--openapi"] != null)
  ) {
    throw new Error("Use --artifact-dir by itself, or use --monorepo/--openapi.");
  }
  return {
    archiveDate: options["--archive-date"],
    artifactDir:
      options["--artifact-dir"] ??
      (options["--monorepo"] != null
        ? path.join(options["--monorepo"], "artifacts/developer-docs")
        : options["--openapi"] == null
          ? defaultArtifactDir
          : undefined),
    check: flags.has("--check"),
    help: false,
    openApiPath:
      options["--openapi"] ??
      (options["--monorepo"] == null
        ? undefined
        : path.join(options["--monorepo"], "docs/api/public-api-v1.openapi.json")),
    toolkitDir: options["--toolkit"],
  };
};

const readText = (filePath) => fs.readFileSync(filePath, "utf8");

const sha256Hex = (sourceText) =>
  crypto.createHash("sha256").update(sourceText).digest("hex");

const artifactRecordForText = (artifactPath, text) => ({
  byteSize: Buffer.byteLength(text, "utf8"),
  path: artifactPath,
  sha256: sha256Hex(text),
});

const docsConfigIncludesPage = (pagePath) => {
  const docsConfigPath = path.join(rootDir, "docs.json");
  if (!fs.existsSync(docsConfigPath)) return false;
  const visit = (value) => {
    if (Array.isArray(value)) {
      return value.some(visit);
    }
    if (typeof value === "string") {
      return value === pagePath;
    }
    if (value == null || typeof value !== "object") {
      return false;
    }
    return Object.values(value).some(visit);
  };
  return visit(JSON.parse(readText(docsConfigPath)));
};

const validateArchiveDate = (archiveDate) => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(archiveDate)) {
    throw new Error("--archive-date must use YYYY-MM-DD.");
  }
  const parsed = new Date(`${archiveDate}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== archiveDate
  ) {
    throw new Error("--archive-date must be a real calendar date.");
  }
  return archiveDate;
};

const archiveDateForManifest = (manifest, requestedArchiveDate) => {
  if (requestedArchiveDate != null) {
    return validateArchiveDate(requestedArchiveDate);
  }
  const generatedAt = manifest.generatedAt;
  if (typeof generatedAt !== "string") {
    throw new Error("Artifact manifest is missing generatedAt.");
  }
  return validateArchiveDate(generatedAt.slice(0, 10));
};

const artifactMetadataFor = (manifest, artifactPath) =>
  manifest.artifacts?.find((artifact) => artifact.path === artifactPath);

const assertArtifactSha = ({ manifest, text, artifactPath }) => {
  const metadata = artifactMetadataFor(manifest, artifactPath);
  if (metadata?.sha256 == null) return;
  if (sha256Hex(text) !== metadata.sha256) {
    throw new Error(`${artifactPath} SHA-256 does not match the manifest.`);
  }
};

const readArtifactText = ({ manifest, resolvedArtifactDir }, artifactPath) => {
  const absolutePath = path.join(resolvedArtifactDir, artifactPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Missing developer docs artifact: ${absolutePath}`);
  }
  const text = readText(absolutePath);
  assertArtifactSha({ manifest, text, artifactPath });
  return text;
};

const syntheticManifestForOpenApi = ({ openApiPath, openApiText }) => {
  const openApi = JSON.parse(openApiText);
  const operationCount = collectOperationIds(openApi).size;
  const stat = fs.statSync(openApiPath);
  return {
    artifact: "ando.developer_docs.openapi",
    generatedAt: stat.mtime.toISOString(),
    inputs: {
      openApi: {
        path: openApiPath,
        sha256: sha256Hex(openApiText),
      },
    },
    openapi: {
      operationCount,
      requiredOperations: requiredOperationIds,
      title: openApi.info?.title ?? "Ando Public API",
      version: openApi.info?.version ?? "v1",
    },
    schemaVersion: 1,
  };
};

const readOpenApiSource = ({ artifactDir, openApiPath }) => {
  if (openApiPath == null) return null;
  const resolvedOpenApiPath = path.resolve(rootDir, openApiPath);
  if (!fs.existsSync(resolvedOpenApiPath)) {
    throw new Error(`Missing OpenAPI source: ${resolvedOpenApiPath}`);
  }
  const openApiText = readText(resolvedOpenApiPath);
  return {
    manifest: syntheticManifestForOpenApi({
      openApiPath: resolvedOpenApiPath,
      openApiText,
    }),
    manifestText: "",
    openApi: JSON.parse(openApiText),
    openApiText,
    resolvedArtifactDir: artifactDir == null ? null : path.resolve(rootDir, artifactDir),
  };
};

const readArtifactBundle = ({ artifactDir, openApiPath }) => {
  if (artifactDir == null) {
    const openApiSource = readOpenApiSource({ artifactDir, openApiPath });
    if (openApiSource != null) {
      return openApiSource;
    }
    throw new Error("Missing developer docs artifact source.");
  }
  const resolvedArtifactDir = path.resolve(rootDir, artifactDir);
  const manifestPath = path.join(
    resolvedArtifactDir,
    "developer-docs-manifest.json"
  );
  const artifactOpenApiPath = path.join(resolvedArtifactDir, latestOpenApiFile);
  if (!fs.existsSync(manifestPath)) {
    const openApiSource = readOpenApiSource({ artifactDir, openApiPath });
    if (openApiSource != null) {
      return openApiSource;
    }
    throw new Error(`Missing developer docs manifest: ${manifestPath}`);
  }
  if (openApiPath == null && !fs.existsSync(artifactOpenApiPath)) {
    throw new Error(`Missing OpenAPI artifact: ${artifactOpenApiPath}`);
  }
  const manifestText = readText(manifestPath);
  const openApiText =
    openApiPath == null
      ? readText(artifactOpenApiPath)
      : readText(path.resolve(rootDir, openApiPath));
  const manifest = JSON.parse(manifestText);
  const openApi = JSON.parse(openApiText);
  const expectedOpenApiSha = manifest.inputs?.openApi?.sha256;
  if (
    typeof expectedOpenApiSha === "string" &&
    sha256Hex(openApiText) !== expectedOpenApiSha
  ) {
    throw new Error("OpenAPI source SHA-256 does not match the manifest.");
  }
  if (openApiPath == null) {
    assertArtifactSha({
      manifest,
      text: openApiText,
      artifactPath: latestOpenApiFile,
    });
  }
  return {
    manifest,
    manifestText,
    openApi,
    openApiText,
    resolvedArtifactDir,
  };
};

const collectOperationIds = (openApi) => {
  const operationIds = new Set();
  for (const pathItem of Object.values(openApi.paths ?? {})) {
    if (pathItem == null || typeof pathItem !== "object") continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (
        !["delete", "get", "patch", "post", "put"].includes(method) ||
        operation == null ||
        typeof operation !== "object" ||
        typeof operation.operationId !== "string"
      ) {
        continue;
      }
      operationIds.add(operation.operationId);
    }
  }
  return operationIds;
};

const assertOpenApiContract = ({ manifest, openApi }) => {
  const operationIds = collectOperationIds(openApi);
  const missingOperationIds = requiredOperationIds.filter(
    (operationId) => !operationIds.has(operationId)
  );
  if (missingOperationIds.length !== 0) {
    throw new Error(
      `OpenAPI artifact is missing required operations: ${missingOperationIds.join(", ")}`
    );
  }
  const manifestOperationCount = manifest.openapi?.operationCount;
  if (
    typeof manifestOperationCount === "number" &&
    manifestOperationCount !== operationIds.size
  ) {
    throw new Error(
      `Manifest operation count ${manifestOperationCount} does not match OpenAPI operation count ${operationIds.size}.`
    );
  }
};

const assertMcpContract = ({ manifest, mcpPublicTools }) => {
  const expectedToolCount = manifest.inputs?.publicMcp?.publicToolCount;
  const expectedOverlapToolCount =
    manifest.inputs?.publicMcp?.publicApiOverlapToolCount;
  const actualToolCount = mcpPublicTools.summary?.publicToolCount;
  const actualOverlapToolCount =
    mcpPublicTools.summary?.publicApiOverlapToolCount;
  if (
    typeof expectedToolCount === "number" &&
    expectedToolCount !== actualToolCount
  ) {
    throw new Error(
      `MCP public tool count ${actualToolCount} does not match manifest count ${expectedToolCount}.`
    );
  }
  if (
    typeof expectedOverlapToolCount === "number" &&
    expectedOverlapToolCount !== actualOverlapToolCount
  ) {
    throw new Error(
      `MCP public API overlap count ${actualOverlapToolCount} does not match manifest count ${expectedOverlapToolCount}.`
    );
  }
};

const assertWebhookEventsContract = ({ manifest, webhookEvents }) => {
  const expectedEventCount = manifest.inputs?.webhookEvents?.eventCount;
  const expectedFingerprint =
    manifest.inputs?.webhookEvents?.sourceFingerprintSha256;
  const actualEventCount = webhookEvents.summary?.eventCount;
  const actualFingerprint = webhookEvents.source?.fingerprintSha256;
  if (
    typeof expectedEventCount === "number" &&
    expectedEventCount !== actualEventCount
  ) {
    throw new Error(
      `Webhook event count ${actualEventCount} does not match manifest count ${expectedEventCount}.`
    );
  }
  if (
    typeof expectedFingerprint === "string" &&
    expectedFingerprint !== actualFingerprint
  ) {
    throw new Error("Webhook event source fingerprint does not match manifest.");
  }
};

const findOptionalArtifactText = (artifactBundle, artifactPath) => {
  if (artifactBundle.resolvedArtifactDir == null) return null;
  const absolutePath = path.join(artifactBundle.resolvedArtifactDir, artifactPath);
  if (!fs.existsSync(absolutePath)) return null;
  return readArtifactText(artifactBundle, artifactPath);
};

const withoutDuplicateFrontmatterTitleHeading = (text) =>
  text?.replace(
    /^(---\ntitle: ([^\n]+)\n[\s\S]*?\n---\n)\n# \2\n\n/u,
    "$1\n"
  );

const mcpToolInputSummaries = {
  add_to_conversation: "`conversation_id`. Optional: `membership_ids`.",
  create_conversation: "`name`. Optional: `access_control_type`, `member_ids`.",
  delete_message: "`message_id`.",
  get_call: "`call_id`.",
  get_call_transcript: "`call_id`. Optional: `limit`, `cursor`.",
  get_conversation_messages: "`conversation_id`. Optional: `author`, `limit`, `before`.",
  get_conversation_threads:
    "`conversation_id`. Optional: `limit`, `before`, `after`, `replies_per_thread`.",
  get_member: "Deprecated; use `get_workspace_member`. Required: `member_id`.",
  get_message: "`message_id`.",
  get_task: "`task_id`.",
  get_thread_replies: "`message_id`. Optional: `limit`, `after`.",
  get_workspace_member: "`workspace_membership_id`.",
  invite_to_workspace: "`email`.",
  join_conversation: "`conversation_id`.",
  list_calls: "Optional: `conversation`, `status`, `recorded`, `after`, `before`, `limit`.",
  list_conversation_members: "`conversation_id`.",
  list_conversations: "Optional: `q`, `limit`.",
  list_members: "Deprecated; use `list_workspace_members`. Optional: `names`.",
  list_public_channels: "Optional: `q`, `limit`.",
  list_workspace_members: "Optional: `names`, `displayNames`.",
  react_to_message: "`message_id`, `emoji`.",
  record_task_update: "`task_id`, `entry`. Optional: `expected_state_version`, `task_patch`, `resource_ops`.",
  remove_from_conversation: "`conversation_id`. Optional: `membership_ids`.",
  reply_to_message: "`message_id`, `markdown_content`.",
  search_calls: "`q`.",
  search_conversations: "`q`.",
  search_members: "Deprecated; use `search_workspace_members`. Required: `q`.",
  search_messages: "`q`. Optional: `author`, `conversation`, `thread`, `after`, `before`, `mode`, `limit`.",
  search_tasks: "Optional: `query`, `limit`.",
  search_workspace_members: "`q`. Optional: `query`, `limit`.",
  send_direct_message: "`member_ids`, `markdown_content`.",
  send_message: "`conversation_id`, `markdown_content`.",
};

// The monorepo artifact has no sidebar icon; the docs page carries one so it
// matches its sibling docs/*.mdx pages. Re-inject it on every sync.
const withMcpToolsSidebarIcon = (mcpPublicToolsMdxText) => {
  if (
    mcpPublicToolsMdxText == null ||
    mcpPublicToolsMdxText.includes("\nicon:")
  ) {
    return mcpPublicToolsMdxText;
  }
  return mcpPublicToolsMdxText.replace(
    /^(---\n[\s\S]*?)(\n---\n)/u,
    "$1\nicon: cable$2"
  );
};

const withMcpToolInputsColumn = ({ mcpPublicToolsMdxText, mcpPublicToolsText }) => {
  if (mcpPublicToolsMdxText == null || mcpPublicToolsText == null) {
    return mcpPublicToolsMdxText;
  }
  if (mcpPublicToolsMdxText.includes("| Tool | Capability | Inputs |")) {
    return mcpPublicToolsMdxText;
  }
  const mcpPublicTools = JSON.parse(mcpPublicToolsText);
  const publicToolNames = (mcpPublicTools.tools ?? []).map((tool) => tool.name);
  const missingInputSummaries = publicToolNames.filter(
    (toolName) => mcpToolInputSummaries[toolName] == null
  );
  if (missingInputSummaries.length !== 0) {
    throw new Error(
      `Missing MCP tool input summaries: ${missingInputSummaries.join(", ")}`
    );
  }

  const lines = mcpPublicToolsMdxText.split("\n");
  return lines
    .map((line) => {
      if (
        line ===
        "| Tool | Capability | Kind | Safety | Deprecation | Public API overlap |"
      ) {
        return "| Tool | Capability | Inputs | Kind | Safety | Deprecation | Public API overlap |";
      }
      if (line === "| --- | --- | --- | --- | --- | --- |") {
        return "| --- | --- | --- | --- | --- | --- | --- |";
      }

      const toolName = line.match(/^\| `([^`]+)` \| /u)?.[1];
      if (toolName == null || mcpToolInputSummaries[toolName] == null) {
        return line;
      }
      const cells = line.slice(2, -2).split(" | ");
      if (cells.length !== 6) return line;
      cells.splice(2, 0, mcpToolInputSummaries[toolName]);
      return `| ${cells.join(" | ")} |`;
    })
    .join("\n");
};

const readToolkitCodeSamples = (toolkitDir) => {
  if (toolkitDir == null) return null;
  const codeSamplesPath = path.resolve(
    rootDir,
    toolkitDir,
    "artifacts/docs/public-api-code-samples.json"
  );
  if (!fs.existsSync(codeSamplesPath)) {
    console.warn(`No Toolkit code samples artifact found at ${codeSamplesPath}; skipping x-codeSamples enrichment.`);
    return null;
  }
  return readText(codeSamplesPath);
};

const codeSamplesByOperationId = (codeSamplesText) => {
  if (codeSamplesText == null) return new Map();
  const parsed = JSON.parse(codeSamplesText);
  const samples =
    Array.isArray(parsed) ? parsed :
    Array.isArray(parsed.samples) ? parsed.samples :
    Array.isArray(parsed.codeSamples) ? parsed.codeSamples :
    [];
  const result = new Map();
  for (const sample of samples) {
    const operationId = sample.operationId ?? sample.operation_id;
    const entries = sample["x-codeSamples"] ?? sample.codeSamples ?? sample.samples;
    if (typeof operationId !== "string" || !Array.isArray(entries)) continue;
    result.set(operationId, entries);
  }
  return result;
};

const withRequiredExampleCompatibilityFields = (openApi) => {
  const nextOpenApi = structuredClone(openApi);
  const searchMessagesExample =
    nextOpenApi.paths?.["/search/messages"]?.get?.responses?.["200"]?.content?.[
      "application/json"
    ]?.examples?.messages?.value;
  const addAuthorAlias = (item) => {
    if (
      item == null ||
      typeof item !== "object" ||
      typeof item.authorWorkspaceMembershipId === "string" ||
      typeof item.author_id !== "string"
    ) {
      return;
    }
    item.authorWorkspaceMembershipId = item.author_id;
  };
  for (const item of searchMessagesExample?.data?.items ?? []) {
    addAuthorAlias(item);
  }
  for (const item of searchMessagesExample?.items ?? []) {
    addAuthorAlias(item);
  }
  return nextOpenApi;
};

const withToolkitCodeSamples = ({ codeSamplesText, openApi }) => {
  const samplesByOperationId = codeSamplesByOperationId(codeSamplesText);
  if (samplesByOperationId.size === 0) return openApi;
  const nextOpenApi = structuredClone(openApi);
  for (const pathItem of Object.values(nextOpenApi.paths ?? {})) {
    if (pathItem == null || typeof pathItem !== "object") continue;
    for (const method of ["delete", "get", "patch", "post", "put"]) {
      const operation = pathItem[method];
      if (
        operation == null ||
        typeof operation !== "object" ||
        typeof operation.operationId !== "string"
      ) {
        continue;
      }
      const samples = samplesByOperationId.get(operation.operationId);
      if (samples != null) {
        operation["x-codeSamples"] = samples;
      }
    }
  }
  return nextOpenApi;
};

const expectedWritesForArtifacts = ({
  archiveDate,
  codeSamplesText,
  includeMcpPublicTools,
  includeWebhookEvents,
  manifestText,
  mcpPublicToolsMdxText,
  mcpPublicToolsText,
  openApiText,
  webhookEventsMdxText,
  webhookEventsText,
}) => {
  const datedArchiveFile = `openapi-public-api-v1-${archiveDate}.json`;
  const writes = new Map([
    [latestOpenApiFile, openApiText],
    [datedArchiveFile, openApiText],
    ...openApiAliasFiles.map((aliasFile) => [aliasFile, openApiText]),
  ]);
  if (manifestText !== "") {
    writes.set(manifestOutputFile, manifestText);
  }
  if (
    includeMcpPublicTools &&
    mcpPublicToolsText != null &&
    mcpPublicToolsMdxText != null
  ) {
    writes.set(mcpPublicToolsDataFile, mcpPublicToolsText);
    writes.set(mcpPublicToolsReferenceFile, mcpPublicToolsMdxText);
  }
  if (
    includeWebhookEvents &&
    webhookEventsText != null &&
    webhookEventsMdxText != null
  ) {
    writes.set(webhookEventsDataFile, webhookEventsText);
    writes.set(webhookEventsReferenceFile, webhookEventsMdxText);
  }
  if (codeSamplesText != null) {
    writes.set(toolkitCodeSamplesDataFile, codeSamplesText);
  }
  return writes;
};

const manifestTextForExpectedWrites = ({
  archiveDate,
  manifest,
  manifestText,
  openApiText,
}) => {
  if (manifestText === "") return "";
  const nextManifest = structuredClone(manifest);
  const datedArchiveFile = `openapi-public-api-v1-${archiveDate}.json`;
  const openApiOutputFiles = [
    "openapi.json",
    latestOpenApiFile,
    datedArchiveFile,
    "api-reference/openapi.json",
  ];
  const retainedArtifacts = Array.isArray(nextManifest.artifacts)
    ? nextManifest.artifacts.filter(
        (artifact) => !openApiOutputFiles.includes(artifact.path)
      )
    : [];
  nextManifest.artifacts = [
    ...openApiOutputFiles.map((artifactPath) =>
      artifactRecordForText(artifactPath, openApiText)
    ),
    ...retainedArtifacts,
  ];
  if (nextManifest.inputs?.openApi?.sha256 !== sha256Hex(openApiText)) {
    nextManifest.downstreamTransforms = [
      ...(Array.isArray(nextManifest.downstreamTransforms)
        ? nextManifest.downstreamTransforms
        : []),
      {
        name: "mintlify-public-api-example-compatibility-fields",
        description:
          "Adds required compatibility fields to generated OpenAPI examples before publishing docs artifacts.",
      },
    ];
  }
  return `${JSON.stringify(nextManifest, null, 2)}\n`;
};

const listStaleDatedArchives = (expectedArchiveFile) =>
  fs
    .readdirSync(rootDir)
    .filter(
      (fileName) =>
        datedOpenApiPattern.test(fileName) && fileName !== expectedArchiveFile
    );

const writeExpectedFiles = ({ check, expectedWrites }) => {
  const staleFiles = [];
  for (const [relativePath, expectedText] of expectedWrites) {
    const absolutePath = path.join(rootDir, relativePath);
    const actualText = fs.existsSync(absolutePath)
      ? readText(absolutePath)
      : null;
    if (actualText === expectedText) continue;
    if (check) {
      staleFiles.push(relativePath);
      continue;
    }
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, expectedText, "utf8");
    console.log(`Wrote ${relativePath}.`);
  }
  if (staleFiles.length !== 0) {
    throw new Error(
      `Generated developer docs artifacts are stale: ${staleFiles.join(", ")}`
    );
  }
};

const removeStaleArchives = ({ check, expectedArchiveFile }) => {
  const staleArchives = listStaleDatedArchives(expectedArchiveFile);
  if (staleArchives.length === 0) return;
  if (check) {
    throw new Error(
      `Stale dated OpenAPI archives remain: ${staleArchives.join(", ")}`
    );
  }
  for (const archiveFile of staleArchives) {
    fs.rmSync(path.join(rootDir, archiveFile), { force: true });
    console.log(`Removed ${archiveFile}.`);
  }
};

const assertLlmsFresh = () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ando-docs-llms-"));
  try {
    fs.cpSync(rootDir, tempRoot, {
      recursive: true,
      filter: (source) => {
        const relativePath = path.relative(rootDir, source);
        return (
          relativePath === "" ||
          (relativePath !== ".git" &&
            !relativePath.startsWith(".git/") &&
            relativePath !== "node_modules" &&
            !relativePath.startsWith("node_modules/"))
        );
      },
    });
    const result = spawnSync("node", ["scripts/build-llms.mjs"], {
      cwd: tempRoot,
      env: process.env,
      stdio: "inherit",
    });
    if (result.error != null) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `node scripts/build-llms.mjs failed with exit ${result.status}`
      );
    }
    const staleFiles = generatedLlmsFiles.filter((relativePath) => {
      const sourcePath = path.join(rootDir, relativePath);
      const generatedPath = path.join(tempRoot, relativePath);
      const sourceText = fs.existsSync(sourcePath) ? readText(sourcePath) : null;
      const generatedText = fs.existsSync(generatedPath)
        ? readText(generatedPath)
        : null;
      return sourceText !== generatedText;
    });
    if (staleFiles.length !== 0) {
      throw new Error(
        `Generated llms artifacts are stale: ${staleFiles.join(", ")}`
      );
    }
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
};

const syncDeveloperDocs = ({
  archiveDate: requestedArchiveDate,
  artifactDir,
  check = false,
  openApiPath,
  toolkitDir,
}) => {
  const artifactBundle = readArtifactBundle({ artifactDir, openApiPath });
  const { manifest, manifestText } = artifactBundle;
  const codeSamplesText = readToolkitCodeSamples(toolkitDir);
  const openApi = withRequiredExampleCompatibilityFields(
    withToolkitCodeSamples({
      codeSamplesText,
      openApi: artifactBundle.openApi,
    })
  );
  const openApiText = `${JSON.stringify(openApi, null, 2)}\n`;
  const mcpPublicToolsText = findOptionalArtifactText(
    artifactBundle,
    "mcp-public-tools.json"
  );
  const mcpPublicToolsMdxText = withMcpToolsSidebarIcon(
    withMcpToolInputsColumn({
      mcpPublicToolsMdxText: withoutDuplicateFrontmatterTitleHeading(
        findOptionalArtifactText(artifactBundle, "mcp-public-tools.mdx")
      ),
      mcpPublicToolsText,
    })
  );
  const webhookEventsText = findOptionalArtifactText(
    artifactBundle,
    "webhook-events.json"
  );
  const webhookEventsMdxText = findOptionalArtifactText(
    artifactBundle,
    "webhook-events.mdx"
  );
  const includeMcpPublicTools = docsConfigIncludesPage("docs/ando-mcp-tools");
  const includeWebhookEvents = docsConfigIncludesPage("api-reference/webhook-events");
  assertOpenApiContract({ manifest, openApi });
  if (includeMcpPublicTools && mcpPublicToolsText != null) {
    assertMcpContract({
      manifest,
      mcpPublicTools: JSON.parse(mcpPublicToolsText),
    });
  }
  if (includeWebhookEvents && webhookEventsText != null) {
    assertWebhookEventsContract({
      manifest,
      webhookEvents: JSON.parse(webhookEventsText),
    });
  }
  const archiveDate = archiveDateForManifest(manifest, requestedArchiveDate);
  const expectedArchiveFile = `openapi-public-api-v1-${archiveDate}.json`;
  const expectedManifestText = manifestTextForExpectedWrites({
    archiveDate,
    manifest,
    manifestText,
    openApiText,
  });
  const expectedWrites = expectedWritesForArtifacts({
    archiveDate,
    codeSamplesText,
    includeMcpPublicTools,
    includeWebhookEvents,
    manifestText: expectedManifestText,
    mcpPublicToolsMdxText,
    mcpPublicToolsText,
    openApiText,
    webhookEventsMdxText,
    webhookEventsText,
  });
  writeExpectedFiles({ check, expectedWrites });
  removeStaleArchives({ check, expectedArchiveFile });
  if (check) {
    assertLlmsFresh();
  }
  console.log(
    `${check ? "Checked" : "Synced"} developer docs artifacts (${openApi.info?.title ?? "OpenAPI"} ${openApi.info?.version ?? ""}, ${collectOperationIds(openApi).size} operations, ${mcpPublicToolsText == null ? 0 : JSON.parse(mcpPublicToolsText).summary?.publicToolCount ?? 0} MCP tools, ${webhookEventsText == null ? 0 : JSON.parse(webhookEventsText).summary?.eventCount ?? 0} webhook events).`
  );
};

const main = () => {
  const parsedArgs = parseArgs(process.argv.slice(2));
  if (parsedArgs.help) {
    usage();
    return;
  }
  syncDeveloperDocs(parsedArgs);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

export { parseArgs, syncDeveloperDocs, validateArchiveDate };
