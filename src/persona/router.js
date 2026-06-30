import { getDb, saveToDisk } from '../db/sqlite.js';
import { v4 as uuid } from 'uuid';

export class PersonaRouter {
  constructor(registry) {
    this.registry = registry;
    this.db = getDb();
  }

  // 为用户分配人格
  assignPersona(platform, userId, personaId) {
    const existing = this.db.prepare(
      'SELECT * FROM persona_routing WHERE platform = ? AND user_id = ?'
    ).get(platform, userId);

    const id = existing?.id || uuid();
    const now = Date.now();

    this.db.prepare(`
      INSERT OR REPLACE INTO persona_routing (id, persona_id, platform, user_id, assigned_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, personaId, platform, userId, now);

    // 创建对话上下文
    const convId = `conv_${personaId}_${platform}_${userId}`;
    this.db.prepare(`
      INSERT OR REPLACE INTO persona_conversation (id, persona_id, platform, user_id, last_interaction, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(convId, personaId, platform, userId, now, now);

    saveToDisk();
    return { id, personaId, platform, userId };
  }

  // 解析用户对应的人格
  resolvePersona(platform, userId) {
    if (!userId) return this.registry.getDefault();

    // 查路由表
    const route = this.db.prepare(
      'SELECT persona_id FROM persona_routing WHERE platform = ? AND user_id = ?'
    ).get(platform, userId);

    if (route) return this.registry.getPersona(route.persona_id);

    // 未配置路由 → 自动绑定默认人格
    const defaultCtx = this.registry.getDefault();
    if (defaultCtx) {
      this.assignPersona(platform, userId, defaultCtx.personaId);
      return defaultCtx;
    }

    return null;
  }

  // 获取对话上下文
  getConversationContext(personaId, platform, userId) {
    const row = this.db.prepare(
      'SELECT * FROM persona_conversation WHERE persona_id = ? AND platform = ? AND user_id = ?'
    ).get(personaId, platform, userId);
    if (!row) return {};
    try { return JSON.parse(row.context_state || '{}'); } catch { return {}; }
  }

  // 更新对话上下文
  updateConversationContext(personaId, platform, userId, updates) {
    const existing = this.getConversationContext(personaId, platform, userId);
    const merged = { ...existing, ...updates };
    const now = Date.now();

    this.db.prepare(`
      UPDATE persona_conversation
      SET context_state = ?, last_interaction = ?, updated_at = ?
      WHERE persona_id = ? AND platform = ? AND user_id = ?
    `).run(JSON.stringify(merged), now, now, personaId, platform, userId);
  }

  // 列出所有路由
  listRoutes() {
    return this.db.prepare('SELECT * FROM persona_routing ORDER BY platform, user_id').all();
  }
}
