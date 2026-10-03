/* 极简 TS 运行器：递归收集本地 .ts 依赖，转译成 CJS 到临时目录后运行 */
const ts = require('typescript');
const fs = require('fs');
const os = require('os');
const path = require('path');

const entry = path.resolve(process.cwd(), process.argv[2]);
const root = path.resolve(__dirname, '..');
const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tsrun-'));

const visited = new Set();

function resolveLocal(spec, fromFile) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function compileFile(file) {
  if (visited.has(file)) return;
  visited.add(file);
  const source = fs.readFileSync(file, 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      useDefineForClassFields: false,
      esModuleInterop: true,
    },
    fileName: file,
  });
  const rel = path.relative(root, file).replace(/\.tsx?$/, '.js');
  const dest = path.join(outRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, out.outputText);

  const importRe = /(?:import[^'"]*from\s*|require\s*\(\s*|export[^'"]*from\s*)['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRe.exec(source))) {
    const dep = resolveLocal(match[1], file);
    if (dep) compileFile(dep);
  }
}

compileFile(entry);

const entryOut = path.join(outRoot, path.relative(root, entry).replace(/\.tsx?$/, '.js'));
fs.writeFileSync(path.join(outRoot, 'package.json'), JSON.stringify({ type: 'commonjs' }));
process.argv[2] = entryOut;
require(entryOut);
