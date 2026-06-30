import { v4 as uuid } from 'uuid';

// 命令审批队列 —— 高危操作(如shell)默认需要人类批准，防误操作
// 既可在 WebUI 也可在终端批准
class ApprovalQueue {
  constructor() {
    this.pending = new Map(); // id → { id, personaId, type, command, cwd, createdAt, run }
    this.history = [];        // 最近的审批结果
    this._listeners = new Set();
  }

  // 提交一个待批准请求；run 是批准后实际执行的函数（返回结果）
  submit({ personaId, type = 'shell', command, cwd, run }) {
    const id = uuid().slice(0, 8);
    const req = { id, personaId, type, command, cwd, createdAt: Date.now(), run };
    this.pending.set(id, req);
    for (const l of this._listeners) { try { l('submit', req); } catch {} }
    return id;
  }

  list() {
    return [...this.pending.values()].map(({ run, ...rest }) => rest);
  }

  async approve(id) {
    const req = this.pending.get(id);
    if (!req) return { ok: false, error: 'not found' };
    this.pending.delete(id);
    let result;
    try {
      result = await req.run();
      this.history.push({ id, command: req.command, approvedAt: Date.now(), ok: true });
    } catch (e) {
      result = `Error: ${e.message}`;
      this.history.push({ id, command: req.command, approvedAt: Date.now(), ok: false });
    }
    if (this.history.length > 50) this.history.shift();
    for (const l of this._listeners) { try { l('approve', { ...req, result }); } catch {} }
    return { ok: true, result };
  }

  reject(id) {
    const req = this.pending.get(id);
    if (!req) return { ok: false, error: 'not found' };
    this.pending.delete(id);
    this.history.push({ id, command: req.command, rejectedAt: Date.now(), ok: false });
    for (const l of this._listeners) { try { l('reject', req); } catch {} }
    return { ok: true };
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  get count() { return this.pending.size; }
}

export const approvalQueue = new ApprovalQueue();
