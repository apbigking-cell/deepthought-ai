import fs from 'node:fs';
import path from 'node:path';
import { GraphStore } from './graph-store.js';
import { MarkdownDoc } from './md-doc.js';
import { extract, isSupported } from './extractors/index.js';
import { shortHash } from './anchors.js';

export const DEFAULTS = {
  ignoreDirs: ['node_modules', '.git', '.codemap', 'dist', 'build', 'coverage', '.next', 'out', 'vendor'],
  smallProjectMaxFiles: 12,   // <= 此值不展开 modules 层
  maxEdgesPerFile: 40,
  maxMethodsListed: 60,
  includeSummary: false,
  maxScanFiles: 4000,
};

const RESOLVE_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'];

// 构建分层代码依赖图谱。返回统计信息。
export function buildCodeMap(projectRoot, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.config || {}) };
  const store = new GraphStore(projectRoot);
  store.ensureDirs();

  const { files, fileSet } = scanProject(store.root, cfg);
  const fileData = analyzeFiles(store, files);
  resolveImports(store, fileData, fileSet);

  // 模块分组
  const modules = groupModules(fileData);
  const useModules = files.length > cfg.smallProjectMaxFiles && modules.size > 1;
  const layers = useModules ? 3 : 2;

  // 写 L3 文件层
  for (const [fileId, data] of Object.entries(fileData)) {
    const doc = new MarkdownDoc();
    doc.setMeta({ layer: 'L3', fileId, gen: String(Date.now()) });
    doc.upsertNode(fileNodeSpec(fileId, data, cfg));
    store.writeFileDoc(fileId, doc);
  }

  // 写 L2 模块层
  if (useModules) {
    for (const [modId, modFiles] of modules) {
      const doc = new MarkdownDoc();
      doc.setMeta({ layer: 'L2', module: modId, gen: String(Date.now()) });
      doc.upsertNode(moduleNodeSpec(modId, modFiles, fileData, cfg));
      store.writeModuleDoc(modId, doc);
    }
  }

  // 写 L1 总览
  const indexDoc = new MarkdownDoc();
  indexDoc.setMeta({ layer: 'L1', root: path.basename(store.root), files: String(files.length), modules: String(modules.size), layers: String(layers) });
  renderIndex(indexDoc, { useModules, modules, fileData, cfg });
  store.writeIndexDoc(indexDoc);

  // 机器索引
  const index = buildIndexJson(store, { layers, files, fileData, modules, useModules });
  store.saveIndex(index);

  return {
    root: store.root,
    fileCount: files.length,
    moduleCount: modules.size,
    layers,
    useModules,
    sizes: store.sizes(),
  };
}

// ---- 扫描 ----
export function scanProject(root, cfg = DEFAULTS) {
  const files = [];
  const fileSet = new Set();
  const walk = (dir) => {
    if (files.length >= cfg.maxScanFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (cfg.ignoreDirs.includes(e.name) || e.name.startsWith('.')) continue;
        walk(abs);
      } else if (e.isFile() && isSupported(abs)) {
        const fileId = path.relative(root, abs).split(path.sep).join('/');
        files.push({ fileId, abs });
        fileSet.add(fileId);
      }
    }
  };
  walk(root);
  return { files, fileSet };
}

// ---- 提取 ----
export function analyzeFiles(store, files) {
  const data = {};
  for (const { fileId, abs } of files) {
    let code = '';
    try { code = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const ex = extract(code, abs) || { imports: [], exports: [], methods: [], calls: [], degraded: true };
    data[fileId] = {
      fileId,
      abs,
      module: moduleOf(fileId),
      lines: code.split('\n').length,
      codeHash: shortHash(code),
      extract: ex,
      resolvedImports: [],   // 内部 fileId
      externalImports: [],   // 裸模块名
    };
  }
  return data;
}

// ---- import 解析 ----
export function resolveImports(store, fileData, fileSet) {
  for (const data of Object.values(fileData)) {
    const dir = path.dirname(data.fileId);
    for (const im of data.extract.imports || []) {
      const src = im.source;
      if (src.startsWith('.')) {
        const target = resolveRelative(dir, src, fileSet);
        if (target) data.resolvedImports.push(target);
        else data.externalImports.push(src); // 未命中（可能指向未扫描文件）
      } else {
        data.externalImports.push(src);
      }
    }
    data.resolvedImports = [...new Set(data.resolvedImports)];
    data.externalImports = [...new Set(data.externalImports)];
  }
}

// 解析单个文件的 import 列表（updater 复用，避免全量重扫）
export function resolveFileImports(fileId, imports, fileSet) {
  const dir = path.dirname(fileId);
  const resolved = [];
  const external = [];
  for (const im of imports || []) {
    const src = im.source;
    if (src.startsWith('.')) {
      const t = resolveRelative(dir, src, fileSet);
      if (t) resolved.push(t); else external.push(src);
    } else {
      external.push(src);
    }
  }
  return { resolved: [...new Set(resolved)], external: [...new Set(external)] };
}

function resolveRelative(fromDir, src, fileSet) {
  const base = path.posix.normalize(path.posix.join(fromDir.split(path.sep).join('/'), src));
  const candidates = [base];
  for (const ext of RESOLVE_EXTS) candidates.push(base + ext);
  for (const ext of RESOLVE_EXTS) candidates.push(base + '/index' + ext);
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

// ---- 模块分组 ----
export function moduleOf(fileId) {
  const dir = path.posix.dirname(fileId);
  return dir === '.' ? '(root)' : dir;
}

export function groupModules(fileData) {
  const map = new Map();
  for (const data of Object.values(fileData)) {
    if (!map.has(data.module)) map.set(data.module, []);
    map.get(data.module).push(data.fileId);
  }
  for (const arr of map.values()) arr.sort();
  return map;
}

// ---- 节点 spec（builder 与 updater 复用） ----
export function fileNodeSpec(fileId, data, cfg = DEFAULTS) {
  const ex = data.extract;
  const methods = (ex.methods || []).slice(0, cfg.maxMethodsListed).map(m => `${m.name}(L${m.line})`);
  const fields = {
    module: data.module,
    lines: String(data.lines),
    exports: (ex.exports || []).join(', ') || '-',
    imports: (data.resolvedImports || []).join(', ') || '-',
    external: (data.externalImports || []).join(', ') || '-',
    methods: methods.join(', ') || '-',
  };
  if (ex.degraded) fields.precision = 'degraded(regex)';
  if (cfg.includeSummary && data.summary) fields.summary = data.summary;
  const edges = methodEdges(ex, cfg);
  return { id: fileId, kind: 'file', title: fileId, fields, edges };
}

function methodEdges(ex, cfg) {
  const calls = (ex.calls || []).slice(0, cfg.maxEdgesPerFile);
  if (!calls.length) return null;
  const lines = ['flowchart LR'];
  const seen = new Set();
  for (const c of calls) {
    const a = mid(c.from), b = mid(c.to);
    const key = a + '>' + b;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  ${a}["${esc(c.from)}"] --> ${b}["${esc(c.to)}"]`);
  }
  return lines.length > 1 ? lines : null;
}

export function moduleNodeSpec(modId, modFiles, fileData, cfg = DEFAULTS) {
  const fields = {
    files: modFiles.join(', '),
    count: String(modFiles.length),
  };
  // 模块内文件级 import 连线
  const lines = ['flowchart LR'];
  const seen = new Set();
  const inMod = new Set(modFiles);
  for (const fid of modFiles) {
    const d = fileData[fid];
    for (const dep of d.resolvedImports || []) {
      if (!inMod.has(dep)) continue; // 仅画模块内连线
      const a = mid(fid), b = mid(dep);
      const key = a + '>' + b;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  ${a}["${esc(short(fid))}"] --> ${b}["${esc(short(dep))}"]`);
    }
  }
  return { id: `mod:${modId}`, kind: 'module', title: `module ${modId}`, fields, edges: lines.length > 1 ? lines : null };
}

export function renderIndex(doc, { useModules, modules, fileData, cfg }) {
  if (useModules) {
    // 模块级总览连线
    const lines = ['flowchart LR'];
    const seen = new Set();
    for (const data of Object.values(fileData)) {
      for (const dep of data.resolvedImports || []) {
        const ma = data.module, mb = moduleOf(dep);
        if (ma === mb) continue;
        const a = mid(ma), b = mid(mb);
        const key = a + '>' + b;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`  ${a}["${esc(ma)}"] --> ${b}["${esc(mb)}"]`);
      }
    }
    doc.setOverview(lines.length > 1 ? lines : ['flowchart LR', '  root["(no cross-module edges)"]']);
    for (const [modId, modFiles] of modules) {
      doc.upsertNode({
        id: `mod:${modId}`, kind: 'module-ref', title: modId,
        fields: { files: String(modFiles.length), detail: `modules/${GraphStore.sane(modId)}.md` },
      });
    }
  } else {
    // 小项目：文件级总览连线 + 每文件一行
    const lines = ['flowchart LR'];
    const seen = new Set();
    for (const data of Object.values(fileData)) {
      for (const dep of data.resolvedImports || []) {
        const a = mid(data.fileId), b = mid(dep);
        const key = a + '>' + b;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`  ${a}["${esc(short(data.fileId))}"] --> ${b}["${esc(short(dep))}"]`);
      }
    }
    doc.setOverview(lines.length > 1 ? lines : ['flowchart LR', '  root["(no internal edges)"]']);
    for (const data of Object.values(fileData)) {
      doc.upsertNode({
        id: data.fileId, kind: 'file-ref', title: data.fileId,
        fields: {
          exports: (data.extract.exports || []).join(', ') || '-',
          detail: `files/${GraphStore.sane(data.fileId)}.md`,
        },
      });
    }
  }
}

function buildIndexJson(store, { layers, files, fileData, modules, useModules }) {
  const filesIdx = {};
  for (const [fileId, d] of Object.entries(fileData)) {
    filesIdx[fileId] = {
      module: d.module,
      codeHash: d.codeHash,
      lines: d.lines,
      degraded: !!d.extract.degraded,
      methods: (d.extract.methods || []).map(m => ({ name: m.name, line: m.line })),
      exports: d.extract.exports || [],
      imports: d.resolvedImports || [],
      external: d.externalImports || [],
      mdFile: path.relative(store.dir, store.fileDocPath(fileId)).split(path.sep).join('/'),
    };
  }
  const modulesIdx = {};
  for (const [modId, modFiles] of modules) {
    modulesIdx[modId] = {
      files: modFiles,
      mdFile: useModules ? path.relative(store.dir, store.moduleDocPath(modId)).split(path.sep).join('/') : null,
    };
  }
  return {
    version: 1,
    root: store.root,
    generatedAt: new Date().toISOString(),
    layers,
    useModules,
    counts: { files: files.length, modules: modules.size },
    files: filesIdx,
    modules: modulesIdx,
  };
}

// ---- mermaid 工具 ----
function mid(name) { return 'n_' + String(name).replace(/[^a-zA-Z0-9]/g, '_'); }
function esc(s) { return String(s).replace(/"/g, "'"); }
function short(fileId) { return String(fileId).split('/').slice(-2).join('/'); }
