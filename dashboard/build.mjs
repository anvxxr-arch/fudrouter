import { compile } from 'svelte/compiler';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');
const outDir = path.join(__dirname, 'public', 'assets');

fs.mkdirSync(outDir, { recursive: true });

function walkDir(dir, ext) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walkDir(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

function rewriteImports(code, fromDir) {
  // Rewrite relative imports to include .js extension
  return code.replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g, (match, prefix, importPath, suffix) => {
    if (path.extname(importPath)) return match;
    const resolved = path.resolve(fromDir, importPath);
    if (fs.existsSync(resolved + '.ts')) {
      return prefix + importPath + '.js' + suffix;
    }
    if (fs.existsSync(resolved + '.js')) {
      return prefix + importPath + '.js' + suffix;
    }
    return match;
  });
}

function compileSvelteFile(srcPath) {
  const rel = path.relative(srcDir, srcPath);
  const outPath = path.join(outDir, rel.replace('.svelte', '.js'));
  const cssPath = path.join(outDir, rel.replace('.svelte', '.css'));
  
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  
  const source = fs.readFileSync(srcPath, 'utf-8');
  const result = compile(source, {
    generate: 'dom',
    css: 'external',
    dev: false,
    filename: srcPath,
  });
  
  // Rewrite .svelte imports to .js
  let jsCode = result.js.code;
  jsCode = jsCode.replace(/from\s+['"]([^'"]+)\.svelte['"]/g, "from '$1.js'");
  
  fs.writeFileSync(outPath, jsCode);
  if (result.css?.code) {
    fs.writeFileSync(cssPath, result.css.code);
  }
  
  return outPath;
}

// Compile all Svelte files
const svelteFiles = walkDir(srcDir, '.svelte');
for (const file of svelteFiles) {
  try {
    compileSvelteFile(file);
    console.log(`✓ ${path.relative(srcDir, file)}`);
  } catch (err) {
    console.error(`✗ ${path.relative(srcDir, file)}: ${err.message}`);
  }
}

// Copy TS files with rewritten imports
const tsFiles = walkDir(srcDir, '.ts');
for (const file of tsFiles) {
  const rel = path.relative(srcDir, file);
  const outPath = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const code = fs.readFileSync(file, 'utf-8');
  const rewritten = rewriteImports(code, path.dirname(file));
  fs.writeFileSync(outPath, rewritten);
  console.log(`✓ ${rel}`);
}

// Write entry point
const entryContent = `import { mount } from 'svelte';
import App from './App.js';
const app = mount(App, { target: document.getElementById('app') });
export default app;
`;
fs.writeFileSync(path.join(outDir, 'entry.js'), entryContent);

console.log('Build complete!');
