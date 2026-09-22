// Test/research runner only. Production continues to use Next.js compilation.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
exports.createLoader = function () {
  const cache = new Map();
  function load(file) {
    file = path.resolve(root, file);
    if (!path.extname(file)) file += '.ts';
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText;
    const localRequire = (name) => name === 'server-only' ? {} : name.startsWith('@/')
      ? load(path.join(root, 'src', name.slice(2))) : name.startsWith('.')
      ? load(path.resolve(path.dirname(file), name)) : require(name);
    new Function('require', 'module', 'exports', '__dirname', '__filename', source)(localRequire, module, module.exports, path.dirname(file), file);
    return module.exports;
  }
  return load;
};
