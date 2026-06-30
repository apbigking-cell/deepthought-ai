import { RE, parseAttrs, serializeAttrs, FIELD_RE, fieldLine, shortHash } from './anchors.js';

// MarkdownDoc —— 把 CodeMap 的 md 当数据库精准操作。
// 解析为有序区块：free(原样文本) / node(受管区块) / overview / meta。
// 所有写操作都是区块级 in-place，绝不触碰未受管文本，保证不破坏结构。
//
// node 区块结构（受管）：
//   <!-- @node id=ID kind=KIND hash=H -->
//   ### Title
//   - key: value
//   <!-- @edges id=ID -->
//   ```mermaid
//   ...
//   ```
//   <!-- @/node id=ID -->
export class MarkdownDoc {
  constructor(text = '') {
    this.blocks = [];
    this._parse(text || '');
  }

  static from(text) { return new MarkdownDoc(text); }

  _parse(text) {
    const lines = text.split('\n');
    let free = [];
    const flushFree = () => { if (free.length) { this.blocks.push({ kind: 'free', lines: free }); free = []; } };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // meta 单行
      const metaM = line.match(RE.meta);
      if (metaM && /@meta/.test(line)) {
        flushFree();
        this.blocks.push({ kind: 'meta', attrs: parseAttrs(metaM[1]), line });
        continue;
      }

      // overview 块
      if (RE.overviewOpen.test(line)) {
        flushFree();
        const open = line;
        const body = [];
        let close = '<!-- @/overview -->';
        i++;
        for (; i < lines.length; i++) {
          if (RE.overviewClose.test(lines[i])) { close = lines[i]; break; }
          body.push(lines[i]);
        }
        this.blocks.push({ kind: 'overview', open, bodyLines: body, close });
        continue;
      }

      // node 块
      const openM = line.match(RE.nodeOpen);
      if (openM && /@node/.test(line) && !/@\/node/.test(line)) {
        flushFree();
        const attrs = parseAttrs(openM[1]);
        const open = line;
        const body = [];
        let close = `<!-- @/node id=${attrs.id} -->`;
        i++;
        for (; i < lines.length; i++) {
          const cM = lines[i].match(RE.nodeClose);
          if (cM) { close = lines[i]; break; }
          body.push(lines[i]);
        }
        this.blocks.push({ kind: 'node', id: attrs.id, attrs, open, bodyLines: body, close });
        continue;
      }

      free.push(line);
    }
    flushFree();
  }

  // ============ 查询 ============

  listNodes() {
    return this.blocks.filter(b => b.kind === 'node').map(b => ({ id: b.id, kind: b.attrs.kind, hash: b.attrs.hash }));
  }

  hasNode(id) { return this.blocks.some(b => b.kind === 'node' && b.id === id); }

  _findNode(id) { return this.blocks.find(b => b.kind === 'node' && b.id === id) || null; }

  getNode(id) {
    const b = this._findNode(id);
    if (!b) return null;
    return {
      id: b.id,
      kind: b.attrs.kind,
      hash: b.attrs.hash,
      title: this._readTitle(b.bodyLines),
      fields: this._readFields(b.bodyLines),
      edges: this._readEdges(b.bodyLines),
    };
  }

  getField(id, key) {
    const b = this._findNode(id);
    if (!b) return null;
    for (const ln of b.bodyLines) {
      const m = ln.match(FIELD_RE);
      if (m && m[1] === key) return m[2];
    }
    return null;
  }

  getMeta() {
    const b = this.blocks.find(x => x.kind === 'meta');
    return b ? { ...b.attrs } : null;
  }

  getOverview() {
    const b = this.blocks.find(x => x.kind === 'overview');
    return b ? this._extractMermaid(b.bodyLines) : null;
  }

  // ============ 精准写（surgical，最小改动） ============

  // 改某字段（不存在则插入到字段区末尾），不重写整块
  setField(id, key, value) {
    const b = this._findNode(id);
    if (!b) return false;
    let done = false;
    for (let i = 0; i < b.bodyLines.length; i++) {
      const m = b.bodyLines[i].match(FIELD_RE);
      if (m && m[1] === key) { b.bodyLines[i] = fieldLine(key, value); done = true; break; }
    }
    if (!done) {
      const insertAt = this._fieldsEndIndex(b.bodyLines);
      b.bodyLines.splice(insertAt, 0, fieldLine(key, value));
    }
    this._rehash(b);
    return true;
  }

  // 替换某节点的连线（mermaid）块，不重写字段
  setEdges(id, mermaidLines) {
    const b = this._findNode(id);
    if (!b) return false;
    const arr = Array.isArray(mermaidLines) ? mermaidLines : String(mermaidLines).split('\n');
    const edgesIdx = b.bodyLines.findIndex(l => RE.edgesOpen.test(l));
    const fence = ['```mermaid', ...arr, '```'];
    if (edgesIdx === -1) {
      b.bodyLines.push(`<!-- @edges id=${id} -->`, ...fence);
    } else {
      // 定位 edgesOpen 后的 mermaid 围栏并整体替换
      let start = edgesIdx + 1;
      while (start < b.bodyLines.length && !b.bodyLines[start].startsWith('```')) start++;
      let end = start + 1;
      while (end < b.bodyLines.length && !b.bodyLines[end].startsWith('```')) end++;
      if (start < b.bodyLines.length) {
        b.bodyLines.splice(start, (end - start + 1), ...fence);
      } else {
        b.bodyLines.splice(edgesIdx + 1, 0, ...fence);
      }
    }
    this._rehash(b);
    return true;
  }

  // 整块新增/替换节点（结构变化时用）
  upsertNode(spec) {
    const { id, kind = 'node', title = id, fields = {}, edges = null } = spec;
    const bodyLines = [];
    if (title) bodyLines.push(`### ${title}`);
    const fieldEntries = Array.isArray(fields) ? fields : Object.entries(fields);
    for (const [k, v] of fieldEntries) {
      if (v === undefined || v === null) continue;
      bodyLines.push(fieldLine(k, Array.isArray(v) ? v.join(', ') : v));
    }
    if (edges && (Array.isArray(edges) ? edges.length : String(edges).trim())) {
      const arr = Array.isArray(edges) ? edges : String(edges).split('\n');
      bodyLines.push(`<!-- @edges id=${id} -->`, '```mermaid', ...arr, '```');
    }
    const hash = shortHash(bodyLines.join('\n'));
    const attrs = { id, kind, hash };
    const block = {
      kind: 'node', id, attrs,
      open: `<!-- @node ${serializeAttrs(attrs)} -->`,
      bodyLines,
      close: `<!-- @/node id=${id} -->`,
    };
    const existing = this.blocks.findIndex(b => b.kind === 'node' && b.id === id);
    if (existing !== -1) {
      this.blocks[existing] = block;
    } else {
      if (this.blocks.length && !this._lastLineBlank()) this.blocks.push({ kind: 'free', lines: [''] });
      this.blocks.push(block);
      this.blocks.push({ kind: 'free', lines: [''] });
    }
    return true;
  }

  removeNode(id) {
    const idx = this.blocks.findIndex(b => b.kind === 'node' && b.id === id);
    if (idx === -1) return false;
    this.blocks.splice(idx, 1);
    // 顺带清理紧随其后的单空行
    if (this.blocks[idx]?.kind === 'free' && this.blocks[idx].lines.join('').trim() === '') {
      this.blocks.splice(idx, 1);
    }
    return true;
  }

  setMeta(attrs) {
    const line = `<!-- @meta ${serializeAttrs(attrs)} -->`;
    const b = this.blocks.find(x => x.kind === 'meta');
    if (b) { b.attrs = { ...attrs }; b.line = line; }
    else this.blocks.unshift({ kind: 'meta', attrs: { ...attrs }, line });
  }

  setOverview(mermaidLines) {
    const arr = Array.isArray(mermaidLines) ? mermaidLines : String(mermaidLines).split('\n');
    const body = ['```mermaid', ...arr, '```'];
    const b = this.blocks.find(x => x.kind === 'overview');
    if (b) { b.bodyLines = body; }
    else {
      this.blocks.push({ kind: 'free', lines: [''] });
      this.blocks.push({ kind: 'overview', open: '<!-- @overview -->', bodyLines: body, close: '<!-- @/overview -->' });
    }
  }

  // ============ 序列化 & 校验 ============

  serialize() {
    const out = [];
    for (const b of this.blocks) {
      if (b.kind === 'free') out.push(...b.lines);
      else if (b.kind === 'meta') out.push(b.line);
      else if (b.kind === 'overview') out.push(b.open, ...b.bodyLines, b.close);
      else if (b.kind === 'node') out.push(b.open, ...b.bodyLines, b.close);
    }
    let text = out.join('\n');
    if (!text.endsWith('\n')) text += '\n';
    return text;
  }

  // 校验结构完整性：锚点配对、mermaid 围栏平衡、字段格式
  validate() {
    const errors = [];
    const seen = new Set();
    for (const b of this.blocks) {
      if (b.kind !== 'node') continue;
      if (seen.has(b.id)) errors.push(`重复节点id: ${b.id}`);
      seen.add(b.id);
      if (!new RegExp(`id=${escapeRe(b.id)}(\\s|$)`).test(b.close)) errors.push(`节点 ${b.id} 闭合锚点id不匹配`);
      // mermaid 围栏平衡
      const fences = b.bodyLines.filter(l => l.trim().startsWith('```')).length;
      if (fences % 2 !== 0) errors.push(`节点 ${b.id} mermaid围栏不平衡`);
      // 节点内不应再嵌套 node 锚点
      if (b.bodyLines.some(l => /@node\s/.test(l) || /@\/node/.test(l))) errors.push(`节点 ${b.id} 内出现嵌套node锚点`);
    }
    return { ok: errors.length === 0, errors };
  }

  // ============ 内部工具 ============

  _readTitle(bodyLines) {
    const t = bodyLines.find(l => /^#{1,6}\s/.test(l));
    return t ? t.replace(/^#{1,6}\s/, '').trim() : null;
  }

  _readFields(bodyLines) {
    const fields = {};
    for (const ln of bodyLines) {
      const m = ln.match(FIELD_RE);
      if (m) fields[m[1]] = m[2];
    }
    return fields;
  }

  _readEdges(bodyLines) {
    const edgesIdx = bodyLines.findIndex(l => RE.edgesOpen.test(l));
    if (edgesIdx === -1) return null;
    return this._extractMermaid(bodyLines.slice(edgesIdx + 1));
  }

  _extractMermaid(lines) {
    const start = lines.findIndex(l => l.trim().startsWith('```'));
    if (start === -1) return null;
    let end = start + 1;
    while (end < lines.length && !lines[end].trim().startsWith('```')) end++;
    return lines.slice(start + 1, end).join('\n');
  }

  _fieldsEndIndex(bodyLines) {
    // 字段插到 @edges 之前；否则插到末尾
    const edgesIdx = bodyLines.findIndex(l => RE.edgesOpen.test(l));
    if (edgesIdx !== -1) return edgesIdx;
    // 找最后一个字段行之后
    let last = -1;
    for (let i = 0; i < bodyLines.length; i++) if (FIELD_RE.test(bodyLines[i])) last = i;
    if (last !== -1) return last + 1;
    // 标题之后
    const titleIdx = bodyLines.findIndex(l => /^#{1,6}\s/.test(l));
    return titleIdx !== -1 ? titleIdx + 1 : bodyLines.length;
  }

  _rehash(b) {
    b.attrs.hash = shortHash(b.bodyLines.join('\n'));
    b.open = `<!-- @node ${serializeAttrs(b.attrs)} -->`;
  }

  _lastLineBlank() {
    const last = this.blocks[this.blocks.length - 1];
    if (!last) return true;
    if (last.kind === 'free') return (last.lines[last.lines.length - 1] || '').trim() === '';
    return false;
  }
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
