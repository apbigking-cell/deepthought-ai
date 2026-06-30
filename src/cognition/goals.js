import { v4 as uuid } from 'uuid';
import { getDb, saveToDisk } from '../db/sqlite.js';

// GoalStore — 目标与能动性：长期目标 / 当前项目 / 今日意图 / 提醒
// status: active | paused | done | abandoned
// kind:   goal | project | intention | reminder
export class GoalStore {
  constructor() {
    this.db = getDb();
  }

  create(personaId, { title, description = '', kind = 'goal', priority = 0.5, projectDir = null, parentId = null, deadline = null }) {
    const id = uuid();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO goals (id, persona_id, title, description, kind, status, priority, progress, parent_id, project_dir, notes, deadline, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, '[]', ?, ?, ?)
    `).run(id, personaId, title, description, kind, priority, parentId, projectDir, deadline, now, now);
    saveToDisk();
    return id;
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    return row ? this._deserialize(row) : null;
  }

  list(personaId, status = null) {
    const rows = status
      ? this.db.prepare('SELECT * FROM goals WHERE persona_id = ? AND status = ? ORDER BY priority DESC, created_at ASC').all(personaId, status)
      : this.db.prepare('SELECT * FROM goals WHERE persona_id = ? ORDER BY priority DESC, created_at ASC').all(personaId);
    return rows.map(r => this._deserialize(r));
  }

  active(personaId) { return this.list(personaId, 'active'); }

  // 选出当前最该推进的目标（优先级高、最久没碰过的）
  pickNext(personaId) {
    const actives = this.active(personaId).filter(g => g.kind === 'goal' || g.kind === 'project');
    if (actives.length === 0) return null;
    actives.sort((a, b) => {
      const pa = (b.priority || 0) - (a.priority || 0);
      if (Math.abs(pa) > 0.01) return pa;
      return (a.last_worked_at || 0) - (b.last_worked_at || 0);
    });
    return actives[0];
  }

  update(id, fields = {}) {
    const g = this.get(id);
    if (!g) return null;
    const now = Date.now();
    const merged = {
      title: fields.title ?? g.title,
      description: fields.description ?? g.description,
      status: fields.status ?? g.status,
      priority: fields.priority ?? g.priority,
      progress: fields.progress ?? g.progress,
      project_dir: fields.projectDir ?? g.project_dir,
      last_worked_at: fields.lastWorkedAt ?? g.last_worked_at,
    };
    this.db.prepare(`
      UPDATE goals SET title=?, description=?, status=?, priority=?, progress=?, project_dir=?, last_worked_at=?, updated_at=?
      WHERE id=?
    `).run(merged.title, merged.description, merged.status, merged.priority, merged.progress, merged.project_dir, merged.last_worked_at, now, id);
    saveToDisk();
    return this.get(id);
  }

  addNote(id, note) {
    const g = this.get(id);
    if (!g) return;
    const notes = Array.isArray(g.notes) ? g.notes : [];
    notes.push({ at: Date.now(), text: String(note).slice(0, 1000) });
    const trimmed = notes.slice(-30);
    this.db.prepare('UPDATE goals SET notes=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(trimmed), Date.now(), id);
    saveToDisk();
  }

  setProgress(id, progress, lastWorked = true) {
    return this.update(id, { progress: Math.max(0, Math.min(1, progress)), lastWorkedAt: lastWorked ? Date.now() : undefined });
  }

  complete(id) { return this.update(id, { status: 'done', progress: 1 }); }
  pause(id) { return this.update(id, { status: 'paused' }); }
  resume(id) { return this.update(id, { status: 'active' }); }
  abandon(id) { return this.update(id, { status: 'abandoned' }); }

  // 到期的提醒/意图（前瞻记忆）
  dueIntentions(personaId, now = Date.now()) {
    return this.active(personaId).filter(g =>
      (g.kind === 'intention' || g.kind === 'reminder') && g.deadline && now >= g.deadline
    );
  }

  _deserialize(row) {
    const obj = { ...row };
    try { obj.notes = JSON.parse(row.notes || '[]'); } catch { obj.notes = []; }
    return obj;
  }
}
