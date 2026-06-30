import fs from 'node:fs';
import path from 'node:path';
import { MarkdownDoc } from './md-doc.js';

// GraphStore —— 管理某个项目根下的 .codemap/ 分层文件与 .codemap.json 机器索引。
//
// 布局：
//   <root>/.codemap/
//     index.md              L1 总览
//     modules/<sane>.md     L2 模块（仅中大项目）
//     files/<sane>.md       L3 文件详情
//     .codemap.json         机器索引（节点/边/哈希/层级/fileId↔文件映射）
export class GraphStore {
  constructor(projectRoot) {
    this.root = path.resolve(projectRoot);
    this.dir = path.join(this.root, '.codemap');
    this.modulesDir = path.join(this.dir, 'modules');
    this.filesDir = path.join(this.dir, 'files');
    this.indexPath = path.join(this.dir, 'index.md');
    this.jsonPath = path.join(this.dir, '.codemap.json');
  }

  exists() { return fs.existsSync(this.jsonPath); }

  ensureDirs() {
    fs.mkdirSync(this.filesDir, { recursive: true });
    fs.mkdirSync(this.modulesDir, { recursive: true });
  }

  // fileId 用相对项目根的正斜杠路径表示
  toFileId(absOrRel) {
    const abs = path.isAbsolute(absOrRel) ? absOrRel : path.join(this.root, absOrRel);
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  // 安全文件名：路径分隔与特殊字符替换为 __
  static sane(id) {
    return String(id).replace(/[\/\\:*?"<>|]+/g, '__').replace(/\.+$/, '');
  }

  fileDocPath(fileId) { return path.join(this.filesDir, GraphStore.sane(fileId) + '.md'); }
  moduleDocPath(modId) { return path.join(this.modulesDir, GraphStore.sane(modId) + '.md'); }

  // ---- md 读写（返回 MarkdownDoc 实例） ----
  readIndexDoc() { return new MarkdownDoc(this._read(this.indexPath)); }
  writeIndexDoc(doc) { this._write(this.indexPath, doc.serialize()); }

  readModuleDoc(modId) { return new MarkdownDoc(this._read(this.moduleDocPath(modId))); }
  writeModuleDoc(modId, doc) { this._write(this.moduleDocPath(modId), doc.serialize()); }

  readFileDoc(fileId) { return new MarkdownDoc(this._read(this.fileDocPath(fileId))); }
  writeFileDoc(fileId, doc) { this._write(this.fileDocPath(fileId), doc.serialize()); }

  readRawFileDoc(fileId) { return this._read(this.fileDocPath(fileId)); }
  readRawModuleDoc(modId) { return this._read(this.moduleDocPath(modId)); }
  readRawIndex() { return this._read(this.indexPath); }

  // ---- 机器索引 ----
  loadIndex() {
    if (!fs.existsSync(this.jsonPath)) return null;
    try { return JSON.parse(fs.readFileSync(this.jsonPath, 'utf8')); }
    catch { return null; }
  }
  saveIndex(index) {
    this.ensureDirs();
    fs.writeFileSync(this.jsonPath, JSON.stringify(index, null, 2), 'utf8');
  }

  // ---- 工具 ----
  _read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
  _write(p, text) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
  }

  // 文件大小统计（用于校验各层 md 受控）
  sizes() {
    const stat = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
    const list = (d) => { try { return fs.readdirSync(d).map(f => ({ name: f, size: stat(path.join(d, f)) })); } catch { return []; } };
    return {
      index: stat(this.indexPath),
      json: stat(this.jsonPath),
      modules: list(this.modulesDir),
      files: list(this.filesDir),
    };
  }
}
