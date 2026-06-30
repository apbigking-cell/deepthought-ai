import * as acorn from 'acorn';

// JS/TS 静态依赖提取器。
// 输出结构（语言无关，供 builder/updater 消费）：
//   {
//     language, ok, degraded,
//     imports: [{ source, names:[] }],   // 模块导入（源字符串，由 builder 解析为 fileId）
//     exports: [name...],
//     methods: [{ name, line, kind }],   // 顶层函数/类方法/导出方法
//     calls:   [{ from, to, line }],     // 方法级调用边（from=所在方法名 或 '<module>'）
//   }
export function extractJs(code, filePath) {
  const isTs = /\.tsx?$/.test(filePath);
  // 先尝试 acorn 精确解析（对纯 JS/JSX 有效；TS 语法会失败 → 降级）
  try {
    const ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
    });
    return walkAst(ast, isTs ? 'ts' : 'js');
  } catch (e) {
    // TS / 解析失败 → 正则降级
    return regexFallback(code, isTs ? 'ts' : 'js');
  }
}

function walkAst(ast, language) {
  const imports = [];
  const exportsArr = [];
  const methods = [];
  const calls = [];

  const stack = ['<module>']; // 当前所在方法名栈
  const top = () => stack[stack.length - 1];

  const calleeName = (node) => {
    if (!node) return null;
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'MemberExpression') {
      const prop = node.property && (node.property.name || node.property.value);
      let obj = null;
      if (node.object.type === 'Identifier') obj = node.object.name;
      else if (node.object.type === 'ThisExpression') obj = 'this';
      else if (node.object.type === 'MemberExpression') obj = node.object.property && node.object.property.name;
      return obj ? `${obj}.${prop}` : prop;
    }
    return null;
  };

  const recordMethod = (name, node, kind) => {
    if (!name) return;
    methods.push({ name, line: node.loc ? node.loc.start.line : 0, kind });
  };

  const walk = (node, className = null) => {
    if (!node || typeof node !== 'object') return;

    switch (node.type) {
      case 'ImportDeclaration': {
        const names = (node.specifiers || []).map(s => s.local && s.local.name).filter(Boolean);
        imports.push({ source: node.source.value, names });
        return;
      }
      case 'ExportNamedDeclaration': {
        if (node.declaration) collectExportNames(node.declaration, exportsArr);
        for (const s of node.specifiers || []) if (s.exported) exportsArr.push(s.exported.name);
        if (node.declaration) walk(node.declaration, className);
        return;
      }
      case 'ExportDefaultDeclaration': {
        exportsArr.push('default');
        walk(node.declaration, className);
        return;
      }
      case 'FunctionDeclaration': {
        const name = node.id ? node.id.name : '<anon>';
        recordMethod(name, node, 'function');
        stack.push(name);
        walkChildren(node, className);
        stack.pop();
        return;
      }
      case 'VariableDeclarator': {
        const init = node.init;
        if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') && node.id.name) {
          recordMethod(node.id.name, node, 'arrow');
          stack.push(node.id.name);
          walkChildren(init, className);
          stack.pop();
          return;
        }
        break;
      }
      case 'ClassDeclaration': {
        const cname = node.id ? node.id.name : '<anonClass>';
        walkChildren(node, cname);
        return;
      }
      case 'MethodDefinition': {
        const mname = node.key && (node.key.name || node.key.value);
        const full = className ? `${className}.${mname}` : mname;
        recordMethod(full, node, 'method');
        stack.push(full);
        walkChildren(node, className);
        stack.pop();
        return;
      }
      case 'CallExpression': {
        const to = calleeName(node.callee);
        // CommonJS require → 也算作 import
        if (node.callee && node.callee.name === 'require' && node.arguments[0] && node.arguments[0].type === 'Literal') {
          imports.push({ source: String(node.arguments[0].value), names: [] });
        } else if (to) {
          calls.push({ from: top(), to, line: node.loc ? node.loc.start.line : 0 });
        }
        walkChildren(node, className);
        return;
      }
      default:
        break;
    }
    walkChildren(node, className);
  };

  const walkChildren = (node, className) => {
    for (const key in node) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const c of val) if (c && typeof c.type === 'string') walk(c, className);
      } else if (val && typeof val.type === 'string') {
        walk(val, className);
      }
    }
  };

  walk(ast, null);

  return {
    language, ok: true, degraded: false,
    imports: dedupeImports(imports),
    exports: [...new Set(exportsArr)],
    methods: dedupeMethods(methods),
    calls: dedupeCalls(calls),
  };
}

function collectExportNames(decl, out) {
  if (!decl) return;
  if (decl.type === 'FunctionDeclaration' && decl.id) out.push(decl.id.name);
  else if (decl.type === 'ClassDeclaration' && decl.id) out.push(decl.id.name);
  else if (decl.type === 'VariableDeclaration') {
    for (const d of decl.declarations) if (d.id && d.id.name) out.push(d.id.name);
  }
}

// 正则降级：用于 TS/TSX 或 acorn 解析失败的情况。
// 只提取 import/export 与定义；调用边留空（降级标记 degraded=true）。
function regexFallback(code, language) {
  const imports = [];
  const exportsArr = [];
  const methods = [];
  const lines = code.split('\n');

  const importRe = /import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = importRe.exec(code)) !== null) imports.push({ source: m[1], names: [] });
  while ((m = requireRe.exec(code)) !== null) imports.push({ source: m[1], names: [] });

  lines.forEach((line, i) => {
    const ln = i + 1;
    let mm;
    if ((mm = line.match(/export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/))) { exportsArr.push(mm[1]); methods.push({ name: mm[1], line: ln, kind: 'function' }); }
    else if ((mm = line.match(/export\s+(?:abstract\s+)?class\s+(\w+)/))) { exportsArr.push(mm[1]); methods.push({ name: mm[1], line: ln, kind: 'class' }); }
    else if ((mm = line.match(/export\s+const\s+(\w+)/))) { exportsArr.push(mm[1]); }
    else if ((mm = line.match(/^\s*(?:async\s+)?function\s+(\w+)/))) { methods.push({ name: mm[1], line: ln, kind: 'function' }); }
    else if ((mm = line.match(/^\s*(?:public|private|protected|static|async|\s)*\s*(\w+)\s*\([^)]*\)\s*[:{]/)) && !/\b(if|for|while|switch|catch|return)\b/.test(line)) {
      // 类方法的弱匹配（可能有误报，作为降级可接受）
      methods.push({ name: mm[1], line: ln, kind: 'method' });
    }
  });

  return {
    language, ok: true, degraded: true,
    imports: dedupeImports(imports),
    exports: [...new Set(exportsArr)],
    methods: dedupeMethods(methods),
    calls: [],
  };
}

function dedupeImports(arr) {
  const map = new Map();
  for (const im of arr) {
    if (!map.has(im.source)) map.set(im.source, { source: im.source, names: new Set() });
    for (const n of im.names || []) map.get(im.source).names.add(n);
  }
  return [...map.values()].map(x => ({ source: x.source, names: [...x.names] }));
}

function dedupeMethods(arr) {
  const seen = new Set();
  const out = [];
  for (const m of arr) {
    const k = `${m.name}@${m.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out.sort((a, b) => a.line - b.line);
}

function dedupeCalls(arr) {
  const seen = new Set();
  const out = [];
  for (const c of arr) {
    const k = `${c.from}->${c.to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}
