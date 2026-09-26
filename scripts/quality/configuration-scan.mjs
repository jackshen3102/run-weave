import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import ts from "typescript";

/** Exact access inventory; aliases, destructuring and computed keys remain reviewable. */
export function configurationAccesses() {
  const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n"))];
  const accesses = new Map();
  function add(file, kind, expression, line) {
    const key = JSON.stringify([file, kind, expression.replace(/\s+/g, " ")]);
    const entry = accesses.get(key) ?? { file, kind, expression: expression.replace(/\s+/g, " "), count: 0, line };
    entry.count++;
    accesses.set(key, entry);
  }
  for (const file of files) {
    if (!/^(backend|electron|frontend|app-server|packages|scripts|plugins)\//.test(file) || /(?:^|\/)(?:Vendor|vendor|dist|node_modules)\//.test(file) || !existsSync(file)) continue;
    if (!/\.(?:[cm]?js|tsx?|swift|py|sh)$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    if (/\.(swift|py|sh)$/.test(file)) {
      source.split("\n").forEach((line, i) => {
        if (/ProcessInfo\.processInfo\.environment|UserDefaults(?:\.|\()|@AppStorage\(|os\.environ|os\.getenv|\$\{?(?:RUNWEAVE|AUTH|APNS|SU[I]?JI)_[A-Z_]+/.test(line)) add(file, "native-or-shell", line.trim(), i + 1);
      });
      continue;
    }
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const aliases = new Set(["env", "environment", "sourceEnv"]);
    const isEnvironment = (node) => node && (aliases.has(node.getText(ast)) || /^(?:process\.env|import\.meta\.env|(?:this|params|options|input|context)\.env)$/.test(node.getText(ast)));
    const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
    // Resolve chains such as const a=process.env; const b=a; before the audit.
    let changed = true;
    while (changed) {
      changed = false;
      walk(ast, node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isEnvironment(node.initializer) && !aliases.has(node.name.text)) { aliases.add(node.name.text); changed = true; }
      });
    }
    walk(ast, node => {
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      if (ts.isPropertyAccessExpression(node) && ["localStorage", "sessionStorage"].includes(node.name.text)) add(file, "device-storage", node.getText(ast), line);
      if (ts.isIdentifier(node) && ["localStorage", "sessionStorage"].includes(node.text) && !ts.isPropertyAccessExpression(node.parent)) add(file, "device-storage", node.text, line);
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isEnvironment(node.expression)) add(file, "environment", node.getText(ast), line);
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && isEnvironment(node.initializer)) add(file, "environment-destructure", node.name.getText(ast), line);
      if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && isEnvironment(node.expression)) add(file, "environment-forward", node.getText(ast), line);
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(ast);
        if (/(?:^|\.)localStorage\.|(?:^|\.)sessionStorage\./.test(name) || /^(?:createJSONStorage|dotenv(?:\.config)?)$/.test(name)) add(file, "device-or-env-loader", node.getText(ast), line);
        // File IO may be legitimate runtime state; every concrete call is classified.
        if (/(?:^|\.)(?:readFile|writeFile|appendFile|readFileSync|writeFileSync|appendFileSync|JSONFilePreset|JSONFileSyncPreset)$/.test(name)) add(file, "file-io", `${name}(${node.arguments[0]?.getText(ast) ?? ""})`, line);
      }
    });
  }
  return [...accesses.values()].sort((a, b) => a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind) || a.expression.localeCompare(b.expression));
}
