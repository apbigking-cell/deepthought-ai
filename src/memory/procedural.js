import { v4 as uuid } from 'uuid';
import { getDb } from '../db/sqlite.js';

// L4 程序记忆 — 基底节/小脑，行为模式/SOP
export class ProceduralMemory {
  constructor() {
    this.db = getDb();
  }

  // 存储行为模式
  storePattern(name, triggerCondition, actionSequence) {
    const id = uuid();

    // 检查是否已有相似模式
    const existing = this.db.prepare(
      'SELECT * FROM procedural_memories WHERE pattern_name = ?'
    ).get(name);

    if (existing) {
      // 更新成功/失败统计
      this.db.prepare(`
        UPDATE procedural_memories
        SET success_count = success_count + 1, last_used = ?
        WHERE id = ?
      `).run(Date.now(), existing.id);
      return existing.id;
    }

    this.db.prepare(`
      INSERT INTO procedural_memories (id, pattern_name, trigger_condition, action_sequence, created_at, last_used)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, triggerCondition || null, JSON.stringify(actionSequence), Date.now(), Date.now());

    return id;
  }

  // 匹配最适合的行为模式
  matchPattern(context) {
    const patterns = this.db.prepare(`
      SELECT * FROM procedural_memories
      ORDER BY success_count DESC
      LIMIT 50
    `).all();

    // 基于触发条件的简单匹配
    const matched = patterns.filter(p => {
      if (!p.trigger_condition) return false;
      try {
        const condition = JSON.parse(p.trigger_condition);
        // 简单的关键词匹配
        if (condition.keywords) {
          return condition.keywords.some(kw =>
            context.toLowerCase().includes(kw.toLowerCase())
          );
        }
        return false;
      } catch {
        return context.includes(p.trigger_condition);
      }
    });

    return matched.map(p => ({
      ...p,
      action_sequence: JSON.parse(p.action_sequence),
      reliability: p.success_count / Math.max(1, p.success_count + p.fail_count),
    }));
  }

  // 记录模式执行结果
  recordOutcome(id, success) {
    const stmt = success
      ? this.db.prepare('UPDATE procedural_memories SET success_count = success_count + 1, last_used = ? WHERE id = ?')
      : this.db.prepare('UPDATE procedural_memories SET fail_count = fail_count + 1 WHERE id = ?');
    stmt.run(Date.now(), id);
  }

  // 获取所有模式
  getAll() {
    return this.db.prepare('SELECT * FROM procedural_memories ORDER BY success_count DESC').all();
  }
}
