import { readFileSync } from "node:fs";
import ts from "typescript";
import { configurationAccesses } from "./configuration-scan.mjs";

const baseline = JSON.parse(readFileSync(new URL("./configuration-accesses.json", import.meta.url), "utf8"));
const categories = new Set(["configuration-adapter", "device-adapter", "runtime-context", "runtime-state", "system", "build", "test", "project", "external-protocol", "migration", "tooling", "distribution"]);
const signature = row => JSON.stringify([row.file, row.kind, row.expression]);
const approved = new Map(baseline.map(row => [signature(row), row]));
const errors = [];
for (const row of baseline) {
  if (!categories.has(row.category) || typeof row.reason !== "string" || row.reason.length < 12 || row.reason.includes("需逐项复核") || !Number.isInteger(row.count) || row.count < 1) errors.push(`Invalid classification: ${row.file} ${row.expression}`);
}
const accesses = configurationAccesses();
for (const row of accesses) {
  const match = approved.get(signature(row));
  if (!match || row.count > match.count) errors.push(`Unreviewed configuration access: ${row.file}:${row.line} [${row.kind}] ${row.expression}`);
}
// Metadata is a pure literal contract, consumed without loading a Node runtime.
const file = "packages/shared/src/configuration/fields.ts";
const source = readFileSync(file, "utf8");
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
let fields;
function literal(node) {
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(property => {
    if (!ts.isPropertyAssignment(property)) throw new Error("Configuration metadata must be literal");
    return [property.name.text, literal(property.initializer)];
  }));
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  throw new Error("Configuration metadata must be literal");
}
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "CONFIGURATION_FIELDS" && node.initializer) {
    fields = literal(node.initializer);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (!Array.isArray(fields) || !fields.length) errors.push("Missing configuration field registry");
const paths = new Set();
for (const field of fields ?? []) {
  for (const key of ["path", "type", "domain", "owner", "scope", "storage", "description", "apply"]) if (typeof field[key] !== "string" || !field[key]) errors.push(`Missing ${key}: ${field.path}`);
  if (paths.has(field.path)) errors.push(`Duplicate field: ${field.path}`);
  paths.add(field.path);
  if (typeof field.sensitive !== "boolean" || typeof field.remote !== "boolean" || !Array.isArray(field.environmentKeys) || !Array.isArray(field.migrationSources) || !field.migrationSources.length) errors.push(`Incomplete field contract: ${field.path}`);
  if (!field.default || Object.hasOwn(field.default, "value") === Object.hasOwn(field.default, "rule") || "rule" in field.default && !field.default.rule) errors.push(`Missing or ambiguous default: ${field.path}`);
  if (field.storage !== "settings.yaml" || field.scope !== "instance" || !["reload", "restart", "immediate"].includes(field.apply)) errors.push(`Invalid ownership contract: ${field.path}`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log(`Configuration governance: ${accesses.length} exact accesses classified; ${fields.length} fields have complete contracts.`);
