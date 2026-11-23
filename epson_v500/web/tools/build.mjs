// Bundle the page into one self-contained HTML file that works from disk:
// double-click it in Chrome or Edge, no server. (A file:// page is a secure
// context, so WebUSB works; only its separate module files would be blocked.)
//
//   node web/tools/build.mjs            -> web/dist/v500-scanner.html
//   node web/tools/build.mjs --check    exit 1 if the file is out of date
//
// A tiny bundler for this code base only: each module becomes a function
// returning its exports; `import {a, b as c} from "./x.js"` and
// `import * as x from "./x.js"` become lookups. No dependencies.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(WEB, "dist/v500-scanner.html");

const IMPORT = /^import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+))\s+from\s+"([^"]+)";\s*$/gm;
const EXPORT_DECL = /^export\s+(async\s+function\*?|function\*?|class|const|let)\s+(\w+)/gm;

const modules = new Map(); // path -> {id, code, deps}

function load(path) {
  if (modules.has(path)) return modules.get(path);
  const src = readFileSync(path, "utf8");
  const mod = { id: modules.size, deps: [], code: "" };
  modules.set(path, mod);
  const exports = [];
  let code = src.replace(IMPORT, (_, names, star, spec) => {
    const dep = load(resolve(dirname(path), spec));
    mod.deps.push(dep);
    if (star) return `const ${star} = __m${dep.id};`;
    const parts = names.split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => s.replace(/^(\w+)\s+as\s+(\w+)$/, "$1: $2"));
    return `const { ${parts.join(", ")} } = __m${dep.id};`;
  });
  code = code.replace(EXPORT_DECL, (_, kind, name) => {
    exports.push(name);
    return `${kind} ${name}`;
  });
  if (/^export\s/m.test(code)) throw new Error(`${relative(WEB, path)}: unsupported export form`);
  mod.code = code;
  mod.exports = exports;
  return mod;
}

function bundle() {
  const entry = load(join(WEB, "app.js"));
  const ordered = [];
  const seen = new Set();
  (function visit(m) {
    if (seen.has(m)) return;
    seen.add(m);
    m.deps.forEach(visit);
    ordered.push(m);
  })(entry);
  const paths = new Map([...modules].map(([p, m]) => [m, relative(WEB, p)]));
  return ordered.map((m) => (m === entry
    ? `// ---- ${paths.get(m)} ----\n${m.code}`
    : `// ---- ${paths.get(m)} ----\nconst __m${m.id} = (() => {\n${m.code}\nreturn { ${m.exports.join(", ")} };\n})();`)).join("\n\n");
}

function page() {
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  const css = readFileSync(join(WEB, "style.css"), "utf8");
  const js = bundle().replace(/<\/script/gi, "<\\/script");
  const out = html
    .replace(/<link rel="stylesheet" href="style.css">/, () => `<style>\n${css}</style>`)
    .replace(/<script type="module" src="app.js"><\/script>/, () => `<script type="module">\n${js}\n</script>`);
  if (out.includes('src="app.js"') || out.includes('href="style.css"')) throw new Error("index.html changed shape: update build.mjs");
  return `<!-- Built by web/tools/build.mjs from web/: edit those, not this file. -->\n${out}`;
}

const html = page();
if (process.argv.includes("--check")) {
  const same = existsSync(OUT) && readFileSync(OUT, "utf8") === html;
  if (!same) {
    console.error(`${relative(process.cwd(), OUT)} is out of date: run node web/tools/build.mjs`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, html);
  console.log(`wrote ${relative(process.cwd(), OUT)} (${(html.length / 1024).toFixed(0)} KB)`);
}
