import fs from 'node:fs';
import path from 'node:path';
import { GraphStore } from './graph-store.js';
import { MarkdownDoc } from './md-doc.js';
import { extract, isSupported } from './extractors/index.js';
import { shortHash } from './anchors.js';
import {
  buildCodeMap, DEFAULTS, fileNodeSpec, moduleNodeSpec, renderIndex,
  groupModules, resolveFileImports, moduleOf, scanProject,
} from './builder.js';

// Updater —— 文件变更后增量更新 codemap，全程本地无 LLM。
// 设计：
//  - 重跑该文件 extractor → md-doc 精准 upsert 文件层节点（区块级替换）
//  - 仅当结构变化（imports/exports/模块归属）才触碰上层 md：
//      · 该文件所在模块的 L2 md（setEdges/setField 精准改）
//      · L1 index 总览（setOverview + ref 字段）
//  - .codemap.json 同步更新
//
// 返回 { changed, structural, reason }

export function updateFile(projectRoot, fileAbsOrId, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.config || {}) };
  const store = new GraphStore(projectRoot);

  // 无索引 → 首次全量构建
  const index = store.loadIndex();
  if (!index) {
    buildCodeMap(projectRoot, opts);
    return { changed: true, structural: true, reason: 'initial-build' };
  }

  const fileId = store.toFileId(fileAbsOrId);
  const abs = path.isAbsolute(fileAbsOrId) ? fileAbsOrId : path.join(store.root, fileAbsOrId);

  // 文件已删除
  if (!fs.existsSync(abs)) {
    return removeFile(store, index, fileId, cfg);
  }
  if (!isSupported(abs)) return { changed: false, structural: false, reason: 'unsupported' };

  let code = '';
  try { code = fs.readFileSync(abs, 'utf8'); } catch { return { changed: false, structural: false, reason: 'read-failed' }; }
  const codeHash = shortHash(code);
  const old = index.files[fileId];
  if (old && old.codeHash === codeHash && !opts.force) {
    return { changed: false, structural: false, reason: 'unchanged' };
  }

  const ex = extract(code, abs) || { imports: [], exports: [], methods: [], calls: [], degraded: true };
  const fileSet = new Set(Object.keys(index.files));
  fileSet.add(fileId);
  const { resolved, external } = resolveFileImports(fileId, ex.imports, fileSet);
  const module = moduleOf(fileId);

  const data = {
    fileId, abs, module, lines: code.split('\n').length,
    codeHash, extract: ex, resolvedImports: resolved, externalImports: external,
  };

  // 1) 文件层 md：区块级 upsert（只动这一个节点）
  const fdoc = store.readFileDoc(fileId);
  if (!fdoc.getMeta()) fdoc.setMeta({ layer: 'L3', fileId, gen: String(Date.now()) });
  fdoc.upsertNode(fileNodeSpec(fileId, data, cfg));
  store.writeFileDoc(fileId, fdoc);

  // 2) 结构变化判定
  const structural = isStructural(old, { resolved, external, exports: ex.exports, module });

  // 3) 更新 .codemap.json
  const isNew = !old;
  index.files[fileId] = {
    module, codeHash, lines: data.lines, degraded: !!ex.degraded,
    methods: (ex.methods || []).map(m => ({ name: m.name, line: m.line })),
    exports: ex.exports || [], imports: resolved, external,
    mdFile: path.relative(store.dir, store.fileDocPath(fileId)).split(path.sep).join('/'),
  };
  if (isNew) {
    if (!index.modules[module]) index.modules[module] = { files: [], mdFile: index.useModules ? `modules/${GraphStore.sane(module)}.md` : null };
    if (!index.modules[module].files.includes(fileId)) index.modules[module].files.push(fileId);
    index.modules[module].files.sort();
    index.counts.files = Object.keys(index.files).length;
    index.counts.modules = Object.keys(index.modules).length;
  }

  // 4) 仅结构变化才动上层
  if (structural || isNew) {
    refreshUpperLayers(store, index, cfg, { touchedModules: [module] });
  }

  index.generatedAt = new Date().toISOString();
  store.saveIndex(index);

  return { changed: true, structural: structural || isNew, reason: isNew ? 'new-file' : (structural ? 'structural' : 'content') };
}

// 项目级增量同步：扫描全项目，仅对变更/新增/删除的文件跑 updateFile。
// 无索引则首次全量构建。返回 { built?, changed }。
export function refreshProject(projectRoot, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.config || {}) };
  const store = new GraphStore(projectRoot);
  const index = store.loadIndex();
  if (!index) {
    buildCodeMap(projectRoot, opts);
    return { built: true, changed: 0 };
  }
  const { files } = scanProject(store.root, cfg);
  const onDisk = new Set(files.map(f => f.fileId));
  let changed = 0;
  for (const { fileId, abs } of files) {
    const e = index.files[fileId];
    let code = '';
    try { code = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (!e || e.codeHash !== shortHash(code)) {
      const r = updateFile(projectRoot, abs, opts);
      if (r.changed) changed++;
    }
  }
  // 已删除的文件
  for (const fileId of Object.keys(store.loadIndex().files)) {
    if (!onDisk.has(fileId)) {
      updateFile(projectRoot, path.join(store.root, fileId), opts);
      changed++;
    }
  }
  return { changed };
}

function removeFile(store, index, fileId, cfg) {
  if (!index.files[fileId]) return { changed: false, structural: false, reason: 'not-tracked' };
  const module = index.files[fileId].module;
  delete index.files[fileId];
  // 删除文件层 md
  try { fs.unlinkSync(store.fileDocPath(fileId)); } catch { /* ignore */ }
  // 模块成员更新
  if (index.modules[module]) {
    index.modules[module].files = index.modules[module].files.filter(f => f !== fileId);
    if (index.modules[module].files.length === 0) {
      try { fs.unlinkSync(store.moduleDocPath(module)); } catch { /* ignore */ }
      delete index.modules[module];
    }
  }
  index.counts.files = Object.keys(index.files).length;
  index.counts.modules = Object.keys(index.modules).length;
  refreshUpperLayers(store, index, cfg, { touchedModules: [module] });
  index.generatedAt = new Date().toISOString();
  store.saveIndex(index);
  return { changed: true, structural: true, reason: 'removed' };
}

// 判断是否发生影响上层的结构变化
function isStructural(old, next) {
  if (!old) return true;
  if (old.module !== next.module) return true;
  if (!sameSet(old.imports, next.resolved)) return true;
  if (!sameSet(old.external, next.external)) return true;
  if (!sameSet(old.exports, next.exports)) return true;
  return false;
}

// 从 index.json 重建轻量 fileData（不读源码、不含 calls，仅供上层连线用）
function reconstructFileData(index) {
  const data = {};
  for (const [fileId, e] of Object.entries(index.files)) {
    data[fileId] = {
      fileId, module: e.module, lines: e.lines,
      resolvedImports: e.imports || [], externalImports: e.external || [],
      extract: { exports: e.exports || [], methods: e.methods || [], calls: [], degraded: !!e.degraded, imports: [] },
    };
  }
  return data;
}

// 精准刷新上层：受影响模块的 L2 md（setEdges/setField）+ L1 index 总览
function refreshUpperLayers(store, index, cfg, { touchedModules = [] } = {}) {
  const fileData = reconstructFileData(index);
  const modules = groupModules(fileData);

  if (index.useModules) {
    // 受影响模块的 L2 md：surgical setEdges + setField
    for (const modId of new Set(touchedModules)) {
      const modFiles = modules.get(modId);
      if (!modFiles) continue; // 模块已空，已删除
      const spec = moduleNodeSpec(modId, modFiles, fileData, cfg);
      const mdoc = store.readModuleDoc(modId);
      if (!mdoc.getMeta()) mdoc.setMeta({ layer: 'L2', module: modId, gen: String(Date.now()) });
      if (mdoc.hasNode(spec.id)) {
        mdoc.setField(spec.id, 'files', spec.fields.files);
        mdoc.setField(spec.id, 'count', spec.fields.count);
        mdoc.setEdges(spec.id, spec.edges || ['flowchart LR', '  empty["(no intra-module edges)"]']);
      } else {
        mdoc.upsertNode(spec);
      }
      store.writeModuleDoc(modId, mdoc);
    }
  }

  // L1 index：surgical 更新总览连线 + ref（结构性，故重建 ref 节点集合，但 overview 用 setOverview）
  const idoc = store.readIndexDoc();
  if (!idoc.getMeta()) idoc.setMeta({ layer: 'L1', root: path.basename(store.root) });
  idoc.setMeta({ layer: 'L1', root: path.basename(store.root), files: String(Object.keys(index.files).length), modules: String(modules.size), layers: String(index.layers) });
  // 总览连线整体替换（setOverview 是区块级安全替换）
  const tmp = new MarkdownDoc();
  renderIndex(tmp, { useModules: index.useModules, modules, fileData, cfg });
  const ov = tmp.getOverview();
  if (ov != null) idoc.setOverview(ov.split('\n'));
  // 同步 ref 节点（新增/删除模块或文件）
  syncRefNodes(idoc, tmp);
  store.writeIndexDoc(idoc);
}

// 把 index doc 的 ref 节点集合对齐到 tmp（新构建的标准集合），精准增删
function syncRefNodes(target, source) {
  const srcNodes = new Map(source.listNodes().map(n => [n.id, n]));
  const tgtIds = new Set(target.listNodes().map(n => n.id));
  // 删除目标中已不存在于标准集合的 ref 节点
  for (const id of tgtIds) {
    if (!srcNodes.has(id)) target.removeNode(id);
  }
  // 新增/更新
  for (const [id, n] of srcNodes) {
    const full = source.getNode(id);
    if (!target.hasNode(id)) {
      target.upsertNode({ id, kind: full.kind, title: full.title, fields: full.fields });
    } else {
      for (const [k, v] of Object.entries(full.fields)) target.setField(id, k, v);
    }
  }
}

function sameSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  for (const x of b) if (!s.has(x)) return false;
  return true;
}
