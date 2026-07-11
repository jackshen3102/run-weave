import path from "node:path";
import ts from "typescript";
import { normalizeRelativePath, readSourceFile } from "./scope.mjs";

const PARSED_EXTENSION = /\.(?:cjs|js|jsx|mjs|ts|tsx)$/;
const RESOLUTION_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.mjs",
];

const PACKAGE_ROOTS = new Map([
  ["@runweave/shared", "packages/shared/src/index.ts"],
  ["@runweave/common", "packages/common/src"],
  ["@runweave/terminal-renderer", "packages/terminal-renderer/src/index.ts"],
  ["@runweave/cli", "packages/runweave-cli/src/index.ts"],
]);

export async function analyzeImports(root, sourceFiles) {
  const parsedFiles = sourceFiles.filter((filePath) =>
    PARSED_EXTENSION.test(filePath),
  );
  const sourceSet = new Set(parsedFiles);
  const edges = [];

  for (const source of parsedFiles) {
    const content = await readSourceFile(root, source);
    const sourceFile = ts.createSourceFile(
      source,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForFile(source),
    );
    collectStaticEdges(sourceFile, source, sourceSet, edges);
    collectDynamicEdges(sourceFile, source, sourceSet, edges);
  }

  const runtimeCycles = findCycles(parsedFiles, edges, false);
  const allCycles = findCycles(parsedFiles, edges, true);
  const runtimeSignatures = new Set(runtimeCycles.map(cycleSignature));
  const typeOnlyCycles = allCycles.filter(
    (cycle) => !runtimeSignatures.has(cycleSignature(cycle)),
  );
  const forbiddenImports = edges.filter(isForbiddenEdge).map(formatEdge).sort();
  const sharedRootImports = edges
    .filter((edge) => edge.specifier === "@runweave/shared")
    .map((edge) => edge.source)
    .filter((filePath, index, values) => values.indexOf(filePath) === index)
    .sort();
  const commonRootImports = edges
    .filter((edge) => edge.specifier === "@runweave/common")
    .map(formatEdge)
    .sort();

  return {
    parsedFileCount: parsedFiles.length,
    edgeCount: edges.length,
    runtimeCycles,
    typeOnlyCycles,
    forbiddenImports,
    sharedRootImports,
    commonRootImports,
    edges,
  };
}

export function cycleSignature(cycle) {
  return [...cycle].sort().join("|");
}

function collectStaticEdges(sourceFile, source, sourceSet, edges) {
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      pushResolvedEdge(edges, sourceSet, {
        source,
        specifier,
        typeOnly: isTypeOnlyImport(statement.importClause),
      });
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      pushResolvedEdge(edges, sourceSet, {
        source,
        specifier,
        typeOnly: statement.isTypeOnly,
      });
    }
  }
}

function collectDynamicEdges(sourceFile, source, sourceSet, edges) {
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        pushResolvedEdge(edges, sourceSet, {
          source,
          specifier: node.arguments[0].text,
          typeOnly: false,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function pushResolvedEdge(edges, sourceSet, input) {
  const target = resolveImport(input.source, input.specifier, sourceSet);
  if (!target && !input.specifier.startsWith("@runweave/")) {
    return;
  }
  edges.push({
    ...input,
    target,
  });
}

function resolveImport(source, specifier, sourceSet) {
  if (specifier.startsWith(".")) {
    const base = normalizeRelativePath(
      path.posix.join(path.posix.dirname(source), specifier),
    );
    return resolveCandidate(base, sourceSet);
  }
  for (const [packageName, packageRoot] of PACKAGE_ROOTS) {
    if (specifier === packageName) {
      return sourceSet.has(packageRoot) ? packageRoot : null;
    }
    if (!specifier.startsWith(`${packageName}/`)) {
      continue;
    }
    const subpath = specifier.slice(packageName.length + 1);
    if (packageName === "@runweave/common") {
      return resolveCandidate(
        normalizeRelativePath(path.posix.join(packageRoot, subpath)),
        sourceSet,
      );
    }
    const packageDirectory = path.posix.dirname(packageRoot);
    return resolveCandidate(
      normalizeRelativePath(path.posix.join(packageDirectory, subpath)),
      sourceSet,
    );
  }
  return null;
}

function resolveCandidate(base, sourceSet) {
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (sourceSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isTypeOnlyImport(importClause) {
  if (!importClause) {
    return false;
  }
  if (importClause.isTypeOnly) {
    return true;
  }
  if (importClause.name || !importClause.namedBindings) {
    return false;
  }
  return (
    ts.isNamedImports(importClause.namedBindings) &&
    importClause.namedBindings.elements.length > 0 &&
    importClause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function findCycles(files, edges, includeTypes) {
  const graph = new Map(files.map((filePath) => [filePath, []]));
  for (const edge of edges) {
    if (!edge.target || (!includeTypes && edge.typeOnly)) {
      continue;
    }
    graph.get(edge.source)?.push(edge.target);
  }

  let nextIndex = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];

  function visit(filePath) {
    indexes.set(filePath, nextIndex);
    lowLinks.set(filePath, nextIndex);
    nextIndex += 1;
    stack.push(filePath);
    onStack.add(filePath);

    for (const target of graph.get(filePath) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(
          filePath,
          Math.min(lowLinks.get(filePath), lowLinks.get(target)),
        );
      } else if (onStack.has(target)) {
        lowLinks.set(
          filePath,
          Math.min(lowLinks.get(filePath), indexes.get(target)),
        );
      }
    }

    if (lowLinks.get(filePath) !== indexes.get(filePath)) {
      return;
    }
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== filePath);
    if (component.length > 1) {
      cycles.push(component.sort());
    }
  }

  for (const filePath of files) {
    if (!indexes.has(filePath)) {
      visit(filePath);
    }
  }
  return cycles.sort((left, right) =>
    cycleSignature(left).localeCompare(cycleSignature(right)),
  );
}

function isForbiddenEdge(edge) {
  if (!edge.target) {
    return false;
  }
  if (
    edge.source.startsWith("app/src/services/") &&
    /^(?:app\/src\/(?:components|pages))\//.test(edge.target)
  ) {
    return true;
  }
  if (
    edge.source.startsWith("app/src/store/") &&
    /^(?:app\/src\/(?:components|pages))\//.test(edge.target)
  ) {
    return true;
  }
  if (
    edge.source.startsWith("frontend/src/services/") &&
    /^(?:frontend\/src\/(?:components|pages))\//.test(edge.target)
  ) {
    return true;
  }
  return (
    /^(?:backend\/src\/(?:agent-team|app-server|auth|terminal|voice))\//.test(
      edge.source,
    ) && /^(?:backend\/src\/(?:routes|ws))\//.test(edge.target)
  );
}

function formatEdge(edge) {
  return `${edge.source} -> ${edge.target ?? edge.specifier}`;
}

function scriptKindForFile(filePath) {
  if (filePath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (
    filePath.endsWith(".js") ||
    filePath.endsWith(".mjs") ||
    filePath.endsWith(".cjs")
  ) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}
