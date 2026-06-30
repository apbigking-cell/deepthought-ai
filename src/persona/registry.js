import { getDb, saveToDisk } from '../db/sqlite.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PersonaContext } from './context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEDS_DIR = resolve(__dirname, '..', '..', 'data', 'personas');

export class PersonaRegistry {
  constructor() {
    this.db = getDb();
    this.personas = new Map();     // personaId → PersonaContext
    this.defaultId = 'linxia';
    this._init();
  }

  _init() {
    // 加载数据库中已注册的人格
    const rows = this.db.prepare('SELECT * FROM persona ORDER BY priority DESC').all();
    for (const row of rows) {
      this._loadContext(row.id);
    }
    // 如果是首次运行，自动从旧单例导入默认人格
    if (rows.length === 0) {
      this._importLegacyPersona();
    }
    // 自动注册 data/personas 下尚未入库的种子人格（幂等）
    this._autoRegisterSeeds();
  }

  // 扫描 personas 目录，注册所有尚未入库的种子人格
  _autoRegisterSeeds() {
    try {
      const files = readdirSync(SEEDS_DIR).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const seed = JSON.parse(readFileSync(resolve(SEEDS_DIR, f), 'utf-8'));
          const pid = seed.persona_id || seed.id || f.replace('.seed.json', '').replace('.json', '');
          if (!this.personas.has(pid)) this.registerSeed(f);
        } catch (e) { /* 跳过坏种子 */ }
      }
    } catch { /* 目录不存在 */ }
  }

  _loadContext(personaId) {
    const row = this.db.prepare('SELECT * FROM persona WHERE id = ?').get(personaId);
    if (!row) return null;
    // profile 合并 persona 注册表字段（type / autonomy_mode / work_dir / tool_policy）
    const profile = this._loadProfile(personaId);
    profile.type = row.type || profile.type;
    profile.autonomy_mode = row.autonomy_mode || 'chat';
    profile.work_dir = row.work_dir || null;
    profile.tool_policy = row.tool_policy || profile.tool_policy;
    const dynamic = this._loadDynamic(personaId);
    const ctx = new PersonaContext(personaId, profile, dynamic);
    this.personas.set(personaId, ctx);
    return ctx;
  }

  _loadProfile(personaId) {
    let row = this.db.prepare('SELECT * FROM persona_profile WHERE persona_id = ?').get(personaId);
    // 兼容：默认人格旧数据可能仍在 id=1 且 persona_id 未迁移
    if (!row && personaId === this.defaultId) {
      row = this.db.prepare('SELECT * FROM persona_profile WHERE id = 1').get();
    }
    return row ? this._deserialize(row) : {};
  }

  _loadDynamic(personaId) {
    let row = this.db.prepare('SELECT * FROM persona_dynamic_state WHERE persona_id = ?').get(personaId);
    if (!row && personaId === this.defaultId) {
      row = this.db.prepare('SELECT * FROM persona_dynamic_state WHERE id = 1').get();
    }
    return row ? this._deserialize(row) : {};
  }

  // 取某表下一个可用整数 id
  _nextId(table) {
    const row = this.db.prepare(`SELECT COALESCE(MAX(id),0)+1 AS next FROM ${table}`).get();
    return row?.next || 1;
  }

  _deserialize(row) {
    if (!row) return {};
    const obj = { ...row };
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
        try { obj[key] = JSON.parse(val); } catch {}
      }
    }
    return obj;
  }

  // 从旧的单例 PersonaManager 导入为默认人格
  _importLegacyPersona() {
    const profile = this.db.prepare('SELECT * FROM persona_profile WHERE id = 1').get();
    if (!profile) return;
    const now = Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO persona (id, name, type, is_active, priority, created_at, updated_at)
      VALUES (?, ?, 'social', 1, 100, ?, ?)
    `).run(this.defaultId, profile.name || '林夏', now, now);
    saveToDisk();
    this._loadContext(this.defaultId);
  }

  // === 公开 API ===

  // 从种子JSON注册新人格
  registerSeed(filename) {
    const filePath = resolve(SEEDS_DIR, filename);
    if (!existsSync(filePath)) throw new Error(`Seed file not found: ${filePath}`);

    const seed = JSON.parse(readFileSync(filePath, 'utf-8'));
    const personaId = seed.persona_id || seed.id || filename.replace('.seed.json', '').replace('.json', '');
    const type = seed.type || 'social';
    // 自主等级：种子显式指定优先；否则 professional 默认 work，social 默认 chat
    const autonomyMode = seed.autonomy_mode || (type === 'professional' ? 'work' : 'chat');
    const workDir = seed.work_dir || null;
    const now = Date.now();

    // 写入 persona 注册表
    this.db.prepare(`
      INSERT OR REPLACE INTO persona (id, name, type, is_active, priority, seed_file, tool_policy, autonomy_mode, work_dir, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    `).run(personaId, seed.name, type, seed.priority || 0, filename, JSON.stringify(seed.tool_policy || {}), autonomyMode, workDir, now, now);

    // 写入 profile（按 persona_id 隔离）
    const profileId = this.db.prepare('SELECT id FROM persona_profile WHERE persona_id = ?').get(personaId)?.id
      || (personaId === this.defaultId ? 1 : this._nextId('persona_profile'));
    this.db.prepare(`
      INSERT OR REPLACE INTO persona_profile
        (id, persona_id, name, nickname, gender, age, birthday, mbti, core_traits, communication_style, backstory, identity_context, life_details, emotional_patterns, value_beliefs, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      profileId, personaId,
      seed.name, seed.nickname || '', seed.gender || '', seed.age || 23, seed.birthday || '',
      seed.mbti || '', JSON.stringify(seed.core_traits || []), seed.communication_style || '',
      seed.backstory || '', seed.identity_context || '',
      JSON.stringify(seed.life_details || {}),
      JSON.stringify(seed.emotional_patterns || {}),
      JSON.stringify(seed.value_beliefs || seed.values || {}),
      now, now
    );

    // 写入动态状态（按 persona_id 隔离）
    const ds = seed.dynamic_state || {};
    const dynId = this.db.prepare('SELECT id FROM persona_dynamic_state WHERE persona_id = ?').get(personaId)?.id
      || (personaId === this.defaultId ? 1 : this._nextId('persona_dynamic_state'));
    this.db.prepare(`
      INSERT OR REPLACE INTO persona_dynamic_state
        (id, persona_id, current_mood_summary, social_battery, recent_highlights, ongoing_stories, things_to_remember, last_updated, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      dynId, personaId,
      ds.current_mood_summary || '', ds.social_battery ?? 0.8,
      JSON.stringify(ds.recent_highlights || []), JSON.stringify(ds.ongoing_stories || []),
      JSON.stringify(ds.things_to_remember || []), now, now
    );

    saveToDisk();
    return this._loadContext(personaId);
  }

  // 获取人格上下文
  getPersona(personaId) {
    return this.personas.get(personaId) || this.personas.get(this.defaultId) || null;
  }

  // 设置活跃人格
  activate(personaId) {
    const ctx = this.personas.get(personaId);
    if (!ctx) throw new Error(`Persona not found: ${personaId}`);
    this.db.prepare('UPDATE persona SET is_active = 1 WHERE id = ?').run(personaId);
    return ctx;
  }

  // 列出所有人格
  list(type = null) {
    const all = [...this.personas.values()];
    return type ? all.filter(p => p.type === type) : all;
  }

  // 获取默认人格
  getDefault() {
    return this.personas.get(this.defaultId) || [...this.personas.values()][0] || null;
  }

  // 计数
  get count() { return this.personas.size; }
}
