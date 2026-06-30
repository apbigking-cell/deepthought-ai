import fs from 'node:fs';
import path from 'node:path';
import { GraphStore } from './graph-store.js';
import { buildCodeMap } from './builder.js';

// CodeContextAgent —— 按需逐层放大，从 codemap 取紧凑上下文。
//
// 省钱核心：
//  - 导航用机器索引(.codemap.json)派生的"压缩清单"喂给 LLM，LLM 只输出要放大的"节点ID"
//  - 真正的依赖文本(L3 md 区块) + 真实代码片段在本地按ID/行号抓取，不让 LLM 产出大文本
//  - 逐层放大（模块→文件→方法代码），全程受字符预算约束
//
// 无 LLM 或调用失败时自动降级为关键词启发式选择，保证可用与确定性。
const DEFAULTS = {
  maxModules: 6,
  maxFiles: 8,
  perFileMdBudget: 2000,
  perFileCodeBudget: 2400,
  totalBudget: 60000,
  codeContextLines: 4,   // 方法片段额外上下文行
};

export class CodeContextAgent {
  constructor({ llm = null, config = {} } = {}) {
    this.llm = llm;
    this.cfg = { ...DEFAULTS, ...(config || {}) };
  }

  // 确保已构建；返回 GraphStore + index
  _open(projectRoot) {
    const store = new GraphStore(projectRoot);
    let index = store.loadIndex();
    if (!index) {
      buildCodeMap(projectRoot, { config: this.cfg.builder });
      index = store.loadIndex();
    }
    return { store, index };
  }

  // 主入口：针对任务取上下文
  // 返回 { text, files:[fileId], modules:[modId], degraded, usedLLM, chars }
  async gatherContext(projectRoot, task, opts = {}) {
    const cfg = { ...this.cfg, ...opts };
    const { store, index } = this._open(projectRoot);
    if (!index || !Object.keys(index.files).length) {
      return { text: '(codemap 为空：项目暂无可索引的源码)', files: [], modules: [], degraded: true, usedLLM: false, chars: 0 };
    }

    let usedLLM = false;
    let chosenFiles = [];
    const focus = (opts.focusFiles || []).filter(f => index.files[f]);

    if (focus.length) {
      chosenFiles = focus.slice(0, cfg.maxFiles);
    } else {
      // ---- 导航阶段 ----
      let candidateModules = Object.keys(index.modules);
      if (index.useModules && candidateModules.length > cfg.maxModules) {
        const picked = await this._pickModules(task, index, cfg);
        usedLLM = usedLLM || picked.usedLLM;
        candidateModules = picked.modules.length ? picked.modules : candidateModules;
      }
      // 收集候选文件
      let candidateFiles = [];
      for (const m of candidateModules) {
        if (index.modules[m]) candidateFiles.push(...index.modules[m].files);
      }
      if (!candidateFiles.length) candidateFiles = Object.keys(index.files);

      const pickedF = await this._pickFiles(task, index, candidateFiles, cfg);
      usedLLM = usedLLM || pickedF.usedLLM;
      chosenFiles = pickedF.files.length ? pickedF.files : this._heuristicFiles(task, index, candidateFiles, cfg.maxFiles);
    }

    // 自动补充直接依赖（1 跳），让上下文更完整
    chosenFiles = this._withDirectDeps(chosenFiles, index, cfg.maxFiles);

    // ---- 组装阶段 ----
    const modules = [...new Set(chosenFiles.map(f => index.files[f]?.module).filter(Boolean))];
    const text = this._assemble(store, index, chosenFiles, cfg);
    return { text, files: chosenFiles, modules, degraded: !usedLLM, usedLLM, chars: text.length };
  }

  // 放大单个节点（供 codemap_zoom 工具）：返回该文件 md 区块 + 真实代码
  zoom(projectRoot, nodeId, opts = {}) {
    const cfg = { ...this.cfg, ...opts };
    const { store, index } = this._open(projectRoot);
    if (index.files[nodeId]) {
      return { text: this._fileBlock(store, index, nodeId, cfg, true), kind: 'file', id: nodeId };
    }
    if (index.modules[nodeId.replace(/^mod:/, '')]) {
      const modId = nodeId.replace(/^mod:/, '');
      const md = store.readRawModuleDoc(modId);
      return { text: md.slice(0, cfg.perFileMdBudget * 2), kind: 'module', id: modId };
    }
    return { text: `(未找到节点 ${nodeId})`, kind: 'none', id: nodeId };
  }

  // 概览（供 codemap_query 工具）
  overview(projectRoot) {
    const { store, index } = this._open(projectRoot);
    return {
      counts: index.counts,
      layers: index.layers,
      modules: Object.entries(index.modules).map(([id, m]) => ({ id, files: m.files.length })),
      indexMd: store.readRawIndex(),
    };
  }

  // ---- 导航：LLM 只输出 ID（失败则空） ----
  async _pickModules(task, index, cfg) {
    const listing = Object.entries(index.modules)
      .map(([id, m]) => `- ${id} (${m.files.length} files)`).join('\n');
    const sys = `你是代码导航助手。根据任务，从模块清单中挑选最相关的模块。只返回 JSON：{"modules":["模块id",...]}，最多 ${cfg.maxModules} 个，不要解释。`;
    const user = `任务：${task}\n\n模块清单：\n${listing}`;
    const ids = await this._askIds(sys, user, 'modules');
    return { modules: ids.filter(id => index.modules[id]).slice(0, cfg.maxModules), usedLLM: ids._usedLLM };
  }

  async _pickFiles(task, index, candidateFiles, cfg) {
    const listing = candidateFiles.slice(0, 80).map(f => {
      const e = index.files[f];
      const ex = (e.exports || []).slice(0, 6).join(',') || '-';
      return `- ${f} [exports: ${ex}] [methods: ${(e.methods || []).length}]`;
    }).join('\n');
    const sys = `你是代码导航助手。根据任务，从文件清单中挑选需要查看源码的文件。只返回 JSON：{"files":["文件路径",...]}，最多 ${cfg.maxFiles} 个，按相关度排序，不要解释。`;
    const user = `任务：${task}\n\n文件清单：\n${listing}`;
    const ids = await this._askIds(sys, user, 'files');
    return { files: ids.filter(id => index.files[id]).slice(0, cfg.maxFiles), usedLLM: ids._usedLLM };
  }

  async _askIds(sys, user, key) {
    const out = [];
    out._usedLLM = false;
    if (!this.llm || !this.llm.apiKey) return out;
    try {
      const res = await this.llm.quick(sys, user);
      out._usedLLM = true;
      const json = (res.content || '').match(/\{[\s\S]*\}/)?.[0];
      if (json) {
        const parsed = JSON.parse(json);
        const arr = parsed[key];
        if (Array.isArray(arr)) for (const x of arr) if (typeof x === 'string') out.push(x.trim());
      }
    } catch { /* 降级 */ }
    return out;
  }

  // ---- 启发式降级：关键词打分 ----
  _heuristicFiles(task, index, candidateFiles, limit) {
    const terms = this._terms(task);
    const scored = candidateFiles.map(f => {
      const e = index.files[f];
      const hay = (f + ' ' + (e.exports || []).join(' ') + ' ' + (e.methods || []).map(m => m.name).join(' ')).toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += hay.split(t).length - 1;
      // 文件名命中加权
      for (const t of terms) if (f.toLowerCase().includes(t)) score += 3;
      return { f, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, limit).map(x => x.f);
    // 没有命中则取较小/入口文件兜底
    if (!picked.length) return candidateFiles.slice(0, Math.min(3, limit));
    return picked;
  }

  _terms(task) {
    const t = String(task).toLowerCase();
    const latin = t.match(/[a-z_][a-z0-9_]{2,}/g) || [];
    const cjk = t.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    return [...new Set([...latin, ...cjk])].filter(x => !STOP.has(x));
  }

  _withDirectDeps(files, index, max) {
    const set = new Set(files);
    for (const f of files) {
      for (const dep of index.files[f]?.imports || []) {
        if (set.size >= max) break;
        set.add(dep);
      }
    }
    return [...set].slice(0, max);
  }

  // ---- 组装：md 区块 + 真实代码 ----
  _assemble(store, index, files, cfg) {
    const parts = [];
    parts.push(`# 代码上下文（codemap 放大结果）`);
    parts.push(`项目：${path.basename(index.root)} | 文件 ${index.counts.files} | 模块 ${index.counts.modules} | 选中 ${files.length} 个文件\n`);
    let budget = cfg.totalBudget;
    for (const f of files) {
      if (budget <= 0) { parts.push(`\n…(已达上下文预算，省略其余文件)`); break; }
      const block = this._fileBlock(store, index, f, cfg, budget > cfg.totalBudget * 0.4);
      const slice = block.slice(0, Math.min(block.length, budget));
      parts.push(slice);
      budget -= slice.length;
    }
    return parts.join('\n');
  }

  // 单文件：依赖区块(来自 L3 md) + 关键方法真实代码
  _fileBlock(store, index, fileId, cfg, includeCode = true) {
    const e = index.files[fileId];
    const lines = [`\n## ${fileId}`];
    if (e.degraded) lines.push(`> 注：该文件依赖为正则降级提取，精度有限`);
    lines.push(`- module: ${e.module} | lines: ${e.lines}`);
    lines.push(`- exports: ${(e.exports || []).join(', ') || '-'}`);
    lines.push(`- imports: ${(e.imports || []).join(', ') || '-'}`);
    if ((e.external || []).length) lines.push(`- external: ${e.external.join(', ')}`);

    // 依赖连线（从 L3 md 的 @edges 区块取，已是紧凑 mermaid）
    try {
      const doc = store.readFileDoc(fileId);
      const node = doc.getNode(fileId);
      if (node && node.edges) {
        lines.push('依赖连线:', '```mermaid', node.edges, '```');
      }
    } catch { /* ignore */ }

    // 真实代码片段
    if (includeCode && (e.methods || []).length) {
      const code = this._extractCode(index.root, fileId, e, cfg);
      if (code) lines.push('关键代码:', '```' + langOf(fileId), code, '```');
    }
    return lines.join('\n');
  }

  _extractCode(root, fileId, entry, cfg) {
    let src;
    try { src = fs.readFileSync(path.join(root, fileId), 'utf8'); } catch { return null; }
    const srcLines = src.split('\n');
    const methods = [...(entry.methods || [])].sort((a, b) => a.line - b.line);
    const pieces = [];
    let used = 0;
    for (let i = 0; i < methods.length; i++) {
      if (used >= cfg.perFileCodeBudget) break;
      const start = Math.max(0, methods[i].line - 1);
      const next = methods[i + 1] ? methods[i + 1].line - 1 : srcLines.length;
      const end = Math.min(srcLines.length, Math.min(next, start + 30) + cfg.codeContextLines);
      const seg = srcLines.slice(start, end).join('\n');
      const piece = `// L${methods[i].line} ${methods[i].name}\n${seg}`;
      if (used + piece.length > cfg.perFileCodeBudget) {
        pieces.push(piece.slice(0, cfg.perFileCodeBudget - used) + '\n// …截断');
        used = cfg.perFileCodeBudget;
        break;
      }
      pieces.push(piece);
      used += piece.length;
    }
    return pieces.join('\n\n');
  }
}

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'function', 'const', 'let', 'var', 'import', 'export', 'return', '修改', '实现', '代码', '文件', '一下', '功能', '问题', '需要', '怎么', '如何']);

function langOf(fileId) {
  const ext = path.extname(fileId).slice(1);
  return ({ mjs: 'js', cjs: 'js', jsx: 'js', tsx: 'ts', mts: 'ts', cts: 'ts' })[ext] || ext || '';
}
