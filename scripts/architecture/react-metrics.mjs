import ts from "typescript";
import { readSourceFile } from "./scope.mjs";

export async function analyzeReactMetrics(root, sourceFiles) {
  const files = sourceFiles.filter((filePath) => filePath.endsWith(".tsx"));
  const propTypes = [];
  const jsxCalls = [];
  const longFunctions = [];
  const hookTotals = {
    useEffect: 0,
    useReducer: 0,
    useState: 0,
    storeSubscriptions: 0,
    wholeStoreSubscriptions: [],
  };

  for (const filePath of files) {
    const sourceFile = ts.createSourceFile(
      filePath,
      await readSourceFile(root, filePath),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    collectTopLevelPropTypes(sourceFile, filePath, propTypes);
    visitSourceFile(sourceFile, filePath, {
      hookTotals,
      jsxCalls,
      longFunctions,
    });
  }

  return {
    fileCount: files.length,
    propsAtLeast10: propTypes
      .filter((item) => item.count >= 10)
      .sort(sortByCountThenPath),
    componentCallsAtLeast10: jsxCalls
      .filter((item) => item.count >= 10)
      .sort(sortByCountThenPath),
    functionsAtLeast100: longFunctions
      .filter((item) => item.lines >= 100)
      .sort(
        (left, right) => right.lines - left.lines || comparePath(left, right),
      ),
    functionsAtLeast200: longFunctions
      .filter((item) => item.lines >= 200)
      .sort(
        (left, right) => right.lines - left.lines || comparePath(left, right),
      ),
    hooks: hookTotals,
  };
}

function collectTopLevelPropTypes(sourceFile, filePath, output) {
  for (const statement of sourceFile.statements) {
    if (
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text.endsWith("Props")
    ) {
      output.push({
        file: filePath,
        line: lineOf(sourceFile, statement),
        name: statement.name.text,
        count: statement.members.length,
      });
      continue;
    }
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text.endsWith("Props") &&
      ts.isTypeLiteralNode(statement.type)
    ) {
      output.push({
        file: filePath,
        line: lineOf(sourceFile, statement),
        name: statement.name.text,
        count: statement.type.members.length,
      });
    }
  }
}

function visitSourceFile(sourceFile, filePath, output) {
  function visit(node) {
    if (isFunctionLike(node)) {
      const name = functionName(node);
      const lines = lineSpan(sourceFile, node);
      if (lines >= 100) {
        output.longFunctions.push({
          file: filePath,
          line: lineOf(sourceFile, node),
          name,
          lines,
        });
      }
    }
    if (ts.isCallExpression(node)) {
      collectHookCall(sourceFile, filePath, node, output.hookTotals);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);
      if (/^[A-Z]/.test(tag)) {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        if (attributes.length >= 10) {
          output.jsxCalls.push({
            file: filePath,
            line: lineOf(sourceFile, node),
            name: tag,
            count: attributes.length,
            attributes: attributes.map((attribute) =>
              attribute.name.getText(sourceFile),
            ),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function collectHookCall(sourceFile, filePath, node, totals) {
  const name = callName(node.expression);
  if (name === "useState" || name === "useEffect" || name === "useReducer") {
    totals[name] += 1;
  }
  if (!/^use[A-Z].*Store$/.test(name)) {
    return;
  }
  totals.storeSubscriptions += 1;
  if (node.arguments.length === 0) {
    totals.wholeStoreSubscriptions.push({
      file: filePath,
      line: lineOf(sourceFile, node),
      name,
    });
  }
}

function callName(expression) {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return "";
}

function isFunctionLike(node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  );
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (
    node.parent &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return "(anonymous)";
}

function lineOf(sourceFile, node) {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

function lineSpan(sourceFile, node) {
  const start = lineOf(sourceFile, node);
  const end = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
  return end - start + 1;
}

function sortByCountThenPath(left, right) {
  return right.count - left.count || comparePath(left, right);
}

function comparePath(left, right) {
  return `${left.file}:${left.line}`.localeCompare(
    `${right.file}:${right.line}`,
  );
}
