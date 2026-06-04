#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const generatedFiles = [
  "api-reference/openapi.json",
  "llms-full.txt",
  "llms.txt",
  "openapi-public-api-v1-latest.json",
  "openapi.json",
];

const readTextOrNull = (root, file) => {
  const filePath = path.join(root, file);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
};

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ando-docs-llms-"));
let exitCode = 0;

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
    exitCode = result.status ?? 1;
  } else {
    const staleFiles = generatedFiles.filter(
      (file) => readTextOrNull(rootDir, file) !== readTextOrNull(tempRoot, file)
    );

    if (staleFiles.length !== 0) {
      console.error(
        `LLMs artifacts are stale. Re-run node scripts/build-llms.mjs and commit: ${staleFiles.join(", ")}`
      );
      exitCode = 1;
    } else {
      console.log("LLMs artifacts are fresh.");
    }
  }
} finally {
  fs.rmSync(tempRoot, { force: true, recursive: true });
}

process.exit(exitCode);
