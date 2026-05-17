#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const siteUrl = "https://docs.ando.so";
const latestOpenApiFile = "openapi-public-api-v1-latest.json";
const openApiAliasFiles = ["openapi.json", "api-reference/openapi.json"];
const datedOpenApiPattern = /^openapi-public-api-v1-\d{4}-\d{2}-\d{2}\.json$/;

const readText = (relativePath) =>
  fs.readFileSync(path.join(rootDir, relativePath), "utf8");

const writeText = (relativePath, content) => {
  fs.writeFileSync(path.join(rootDir, relativePath), `${content.trimEnd()}\n`);
};

const parseFrontmatter = (relativePath) => {
  const raw = readText(relativePath);
  if (!raw.startsWith("---\n")) {
    return { body: raw.trim(), frontmatter: {} };
  }
  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error(`Unclosed frontmatter in ${relativePath}`);
  }
  const frontmatterSource = raw.slice(4, end).trim();
  const body = raw.slice(end + "\n---".length).trim();
  const frontmatter = {};
  for (const line of frontmatterSource.split("\n")) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  return { body, frontmatter };
};

const slugify = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const flattenNavigation = (items, sectionTrail = []) => {
  const pages = [];
  const endpoints = [];

  const visit = (item, trail) => {
    if (typeof item === "string") {
      pages.push({ page: item, sectionTrail: trail });
      return;
    }
    if (item == null || typeof item !== "object") {
      return;
    }
    const nextTrail = item.group == null ? trail : [...trail, item.group];
    if (typeof item.openapi === "string") {
      for (const page of item.pages ?? []) {
        if (typeof page === "string") {
          endpoints.push({
            group: item.group ?? "Endpoint reference",
            page,
            tag: item.tag,
          });
        }
      }
      return;
    }
    for (const page of item.pages ?? []) {
      visit(page, nextTrail);
    }
  };

  for (const item of items) {
    visit(item, sectionTrail);
  }

  return { endpoints, pages };
};

const docsConfig = JSON.parse(readText("docs.json"));
if (docsConfig.api?.openapi !== latestOpenApiFile) {
  throw new Error(`docs.json api.openapi must use ${latestOpenApiFile}.`);
}
const datedOpenApiFiles = fs.readdirSync(rootDir).filter((file) =>
  datedOpenApiPattern.test(file)
).sort();
if (datedOpenApiFiles.length !== 1) {
  throw new Error(
    `Expected exactly one dated OpenAPI archive; found ${datedOpenApiFiles.length}.`
  );
}
const datedOpenApiFile = datedOpenApiFiles[0];
const openApiSource = readText(datedOpenApiFile);
const openApi = JSON.parse(openApiSource);
const tabs = docsConfig.navigation?.tabs ?? [];

const allPages = [{ page: "index", sectionTrail: ["Home"] }];
const endpointRefs = [];

for (const tab of tabs) {
  const { endpoints, pages } = flattenNavigation(tab.groups ?? [], [tab.tab]);
  allPages.push(...pages);
  endpointRefs.push(...endpoints);
}

const authoredPages = allPages.filter(({ page }) =>
  fs.existsSync(path.join(rootDir, `${page}.mdx`))
);

const endpointByRef = new Map();
for (const [openApiPath, pathItem] of Object.entries(openApi.paths ?? {})) {
  for (const method of ["get", "post"]) {
    const operation = pathItem[method];
    if (operation == null) continue;
    endpointByRef.set(`${method.toUpperCase()} ${openApiPath}`, {
      method: method.toUpperCase(),
      openApiPath,
      operation,
    });
  }
}

const endpointPagePath = (operation) => {
  const tag = operation.tags?.[0] ?? "API";
  return `api-reference/${slugify(tag)}/${slugify(operation.summary)}`;
};

const endpointEntries = endpointRefs.map((ref) => {
  const endpoint = endpointByRef.get(ref.page);
  if (endpoint == null) {
    throw new Error(`Missing OpenAPI endpoint for docs.json page: ${ref.page}`);
  }
  return {
    ...endpoint,
    group: ref.group,
    pagePath: endpointPagePath(endpoint.operation),
    stability: ref.tag ?? ref.group,
  };
});

const pageMeta = (page) => {
  const parsed = parseFrontmatter(`${page}.mdx`);
  const title = parsed.frontmatter.title ?? page;
  const description = parsed.frontmatter.description ?? "";
  return { ...parsed, description, title };
};

const pageListItem = (page) => {
  const meta = pageMeta(page.page);
  const suffix = meta.description === "" ? "" : `: ${meta.description}`;
  return `- [${meta.title}](${siteUrl}/${page.page}.md)${suffix}`;
};

const endpointListItem = (entry) =>
  `- [${entry.operation.summary}](${siteUrl}/${entry.pagePath}.md): ${entry.operation.description}`;

const groupBy = (entries, key) => {
  const result = new Map();
  for (const entry of entries) {
    const value = key(entry);
    result.set(value, [...(result.get(value) ?? []), entry]);
  }
  return result;
};

const authoredApiPages = authoredPages.filter(({ page }) =>
  page.startsWith("api-reference/")
);
const productPages = authoredPages.filter(
  ({ page }) => page.startsWith("docs/") || page === "index"
);
const changelogPages = authoredPages.filter(
  ({ page }) => page === "changelog" || page === "coming-soon"
);

const endpointGroups = groupBy(endpointEntries, (entry) => entry.group);

const llmsTxt = [
  "# Ando",
  "",
  "> Documentation and API reference for Ando.",
  "",
  "## Public API v1",
  "",
  ...authoredApiPages.map(pageListItem),
  "",
  "## Endpoint reference",
  "",
  ...[...endpointGroups.entries()].flatMap(([group, entries]) => [
    `### ${group}`,
    "",
    ...entries.map(endpointListItem),
    "",
  ]),
  "## Product docs",
  "",
  ...productPages.map(pageListItem),
  "",
  "## Changelog",
  "",
  ...changelogPages.map(pageListItem),
  "",
  "## OpenAPI Specs",
  "",
  `- [${path.basename(latestOpenApiFile, ".json")}](${siteUrl}/${latestOpenApiFile})`,
  `- [${path.basename(datedOpenApiFile, ".json")}](${siteUrl}/${datedOpenApiFile})`,
].join("\n");

const formatParameters = (parameters = []) => {
  if (parameters.length === 0) return "None.";
  return [
    "| Name | Location | Required | Description |",
    "| --- | --- | --- | --- |",
    ...parameters.map(
      (parameter) =>
        `| \`${parameter.name}\` | ${parameter.in} | ${
          parameter.required === true ? "Yes" : "No"
        } | ${parameter.description} |`
    ),
  ].join("\n");
};

const formatRequestBody = (requestBody) => {
  if (requestBody == null) return "None.";
  const schema = requestBody.content?.["application/json"]?.schema;
  if (schema?.$ref != null) {
    return `JSON body: \`${schema.$ref.replace("#/components/schemas/", "")}\`.`;
  }
  return "JSON body.";
};

const formatResponses = (responses = {}) =>
  Object.entries(responses)
    .map(([status, response]) => {
      if (response.$ref != null) {
        return `- ${status}: ${response.$ref.replace("#/components/responses/", "")}`;
      }
      return `- ${status}: ${response.description}`;
    })
    .join("\n");

const formatEndpoint = (entry) =>
  [
    `### ${entry.method} ${entry.openApiPath}`,
    "",
    `Source: ${siteUrl}/${entry.pagePath}`,
    "",
    `Stability: ${entry.stability}`,
    "",
    entry.operation.description,
    "",
    `Canonical request: \`${entry.method} https://api.ando.so/v1${entry.openApiPath}\``,
    "",
    "Parameters:",
    "",
    formatParameters(entry.operation.parameters),
    "",
    "Request body:",
    "",
    formatRequestBody(entry.operation.requestBody),
    "",
    "Responses:",
    "",
    formatResponses(entry.operation.responses),
  ].join("\n");

const formatPage = (page) => {
  const meta = pageMeta(page.page);
  const parts = [
    `# ${meta.title}`,
    `Source: ${siteUrl}/${page.page}`,
    "",
  ];
  if (meta.description !== "") {
    parts.push(`> ${meta.description}`, "");
  }
  parts.push(meta.body);
  return parts.join("\n");
};

const llmsFullTxt = [
  "# Ando",
  "",
  "> Documentation and API reference for Ando.",
  "",
  "Public API v1 uses `https://api.ando.so/v1` as the base URL. New integrations should send `x-api-key` from server-side code. Bearer transport is accepted only for compatibility with older clients.",
  "",
  "## Public API pages",
  "",
  ...authoredApiPages.map(formatPage),
  "",
  "# Endpoint reference",
  "Source: https://docs.ando.so/api-reference/endpoint-reference",
  "",
  ...[...endpointGroups.entries()].flatMap(([group, entries]) => [
    `## ${group}`,
    "",
    ...entries.map(formatEndpoint),
    "",
  ]),
  "## Product docs",
  "",
  ...productPages.map(formatPage),
  "",
  "## Changelog",
  "",
  ...changelogPages.map(formatPage),
].join("\n");

writeText("llms.txt", llmsTxt);
writeText("llms-full.txt", llmsFullTxt);
writeText(latestOpenApiFile, openApiSource);
for (const aliasFile of openApiAliasFiles) {
  writeText(aliasFile, openApiSource);
}
