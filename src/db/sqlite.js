import initSqlJs from 'sql.js';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config.js';

const dbPath = config.db.path;
const dir = dirname(dbPath);

let SQL = null;
let db = null;
let saveTimer = null;

// Init SQL.js (WASM) — async, must be called before anything else
export async function initDatabase() {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  SQL = await initSqlJs();

  // Load existing DB from disk, or create new
  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  setupSchema();

  // Auto-save every 60 seconds
  saveTimer = setInterval(saveToDisk, 60000);

  return db;
}

function setupSchema() {
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS episodic_memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      summary TEXT,
      embedding BLOB,
      valence REAL DEFAULT 0,
      arousal REAL DEFAULT 0,
      significance REAL DEFAULT 0.5,
      source TEXT DEFAULT 'direct',
      access_count INTEGER DEFAULT 0,
      last_accessed INTEGER,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      compression_level INTEGER DEFAULT 0,
      compressed_from TEXT,
      tags TEXT DEFAULT '[]'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS semantic_triples (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      embedding BLOB,
      source_episodic_ids TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      last_reinforced INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS procedural_memories (
      id TEXT PRIMARY KEY,
      pattern_name TEXT NOT NULL,
      trigger_condition TEXT,
      action_sequence TEXT NOT NULL,
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_used INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS meta_memories (
      id TEXT PRIMARY KEY,
      target_memory_id TEXT NOT NULL,
      target_layer INTEGER NOT NULL,
      confidence REAL DEFAULT 1.0,
      inconsistencies TEXT DEFAULT '[]',
      source_attribution TEXT,
      retrieval_history TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS heartbeat_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick_id INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      valence REAL NOT NULL,
      arousal REAL NOT NULL,
      dominance REAL NOT NULL,
      energy REAL NOT NULL,
      social_drive REAL NOT NULL,
      emotion_label TEXT NOT NULL,
      attention_focus TEXT,
      current_thought TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS message_log (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      user_id TEXT,
      content TEXT NOT NULL,
      emotion_at_time TEXT,
      timestamp INTEGER NOT NULL
    )
  `);

  // L6: 人设档案（活的人物，不是死JSON）
  db.run(`
    CREATE TABLE IF NOT EXISTS persona_profile (
      id INTEGER PRIMARY KEY DEFAULT 1,
      name TEXT NOT NULL DEFAULT '林夏',
      nickname TEXT DEFAULT '夏夏',
      gender TEXT DEFAULT '女',
      age INTEGER DEFAULT 23,
      birthday TEXT DEFAULT '03-15',
      mbti TEXT DEFAULT 'ENFP',
      core_traits TEXT NOT NULL DEFAULT '[]',
      communication_style TEXT DEFAULT '',
      backstory TEXT DEFAULT '',
      identity_context TEXT DEFAULT '',
      life_details TEXT DEFAULT '{}',
      emotional_patterns TEXT DEFAULT '{}',
      value_beliefs TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // 人设动态状态（实时更新，每次心跳/叙事都可能变化）
  db.run(`
    CREATE TABLE IF NOT EXISTS persona_dynamic_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      current_mood_summary TEXT DEFAULT '',
      social_battery REAL DEFAULT 0.8,
      recent_highlights TEXT DEFAULT '[]',
      ongoing_stories TEXT DEFAULT '[]',
      things_to_remember TEXT DEFAULT '[]',
      last_updated INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);

  // 人设更新历史（追踪性格/状态的变化轨迹）
  db.run(`
    CREATE TABLE IF NOT EXISTS persona_update_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      source TEXT,
      timestamp INTEGER NOT NULL
    )
  `);

  // === 多角色人格系统（Phase 1）===

  // 人格注册表：每个人格一行
  db.run(`
    CREATE TABLE IF NOT EXISTS persona (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'social',
      is_active INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0,
      seed_file TEXT,
      tool_policy TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // 人格路由：哪个平台的哪个用户对应哪个人格
  db.run(`
    CREATE TABLE IF NOT EXISTS persona_routing (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL REFERENCES persona(id),
      platform TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assigned_at INTEGER NOT NULL,
      UNIQUE(platform, user_id)
    )
  `);

  // 对话上下文：每个人格对每个用户的独立上下文
  db.run(`
    CREATE TABLE IF NOT EXISTS persona_conversation (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL REFERENCES persona(id),
      platform TEXT NOT NULL,
      user_id TEXT NOT NULL,
      context_state TEXT DEFAULT '{}',
      last_interaction INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);

  // 系统配置表（WebUI可读写，覆盖.env默认值）
  db.run(`
    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT DEFAULT '',
      updated_at INTEGER NOT NULL
    )
  `);

  // === 认知改造：心智状态 / 意识流 / 目标（每人格独立）===

  // 每人格的实时心智状态（VAD情绪 + 驱动力 + 注意力 + 当前念头）
  db.run(`
    CREATE TABLE IF NOT EXISTS persona_state (
      persona_id TEXT PRIMARY KEY,
      valence REAL DEFAULT 0,
      arousal REAL DEFAULT 0.3,
      dominance REAL DEFAULT 0.5,
      energy REAL DEFAULT 0.8,
      social_drive REAL DEFAULT 0,
      curiosity REAL DEFAULT 0.5,
      emotion_label TEXT DEFAULT 'neutral',
      attention_focus TEXT,
      current_thought TEXT,
      last_think_at INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `);

  // 意识流：持续的内心独白，可被重新喂回上下文（默认模式网络）
  db.run(`
    CREATE TABLE IF NOT EXISTS thought_stream (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT NOT NULL,
      tick INTEGER,
      kind TEXT DEFAULT 'spontaneous',
      content TEXT NOT NULL,
      reasoning TEXT,
      action TEXT,
      valence REAL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);

  // 目标与能动性：长期目标 / 当前项目 / 今日意图
  db.run(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      kind TEXT DEFAULT 'goal',
      status TEXT DEFAULT 'active',
      priority REAL DEFAULT 0.5,
      progress REAL DEFAULT 0,
      parent_id TEXT,
      project_dir TEXT,
      notes TEXT DEFAULT '[]',
      deadline INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_worked_at INTEGER
    )
  `);

  // === 迁移：为旧表补 persona_id / 为 persona 表补自主等级 ===
  const safeAlter = (sql) => { try { db.run(sql); } catch {} };
  safeAlter(`ALTER TABLE persona_profile ADD COLUMN persona_id TEXT`);
  safeAlter(`ALTER TABLE persona_dynamic_state ADD COLUMN persona_id TEXT`);
  safeAlter(`ALTER TABLE persona ADD COLUMN autonomy_mode TEXT DEFAULT 'chat'`);
  safeAlter(`ALTER TABLE persona ADD COLUMN work_dir TEXT`);
  // 旧的单行数据(id=1)归属默认人格 linxia
  safeAlter(`UPDATE persona_profile SET persona_id = 'linxia' WHERE persona_id IS NULL AND id = 1`);
  safeAlter(`UPDATE persona_dynamic_state SET persona_id = 'linxia' WHERE persona_id IS NULL AND id = 1`);

  // Indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_episodic_time ON episodic_memories(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_episodic_significance ON episodic_memories(significance)');
  db.run('CREATE INDEX IF NOT EXISTS idx_semantic_subject ON semantic_triples(subject)');
  db.run('CREATE INDEX IF NOT EXISTS idx_semantic_object ON semantic_triples(object)');
  db.run('CREATE INDEX IF NOT EXISTS idx_heartbeat_tick ON heartbeat_snapshots(tick_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_message_time ON message_log(timestamp)');
  db.run('CREATE INDEX IF NOT EXISTS idx_persona_type ON persona(type)');
  db.run('CREATE INDEX IF NOT EXISTS idx_persona_routing ON persona_routing(platform, user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_persona_conv ON persona_conversation(persona_id, platform, user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_thought_persona ON thought_stream(persona_id, created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_goals_persona ON goals(persona_id, status)');
  try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_persona ON persona_profile(persona_id)'); } catch {}
  try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_dynamic_persona ON persona_dynamic_state(persona_id)'); } catch {}
}

export function saveToDisk() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    writeFileSync(dbPath, buffer);
  } catch (e) {
    console.error('[DB] Save failed:', e.message);
  }
}

export function closeDatabase() {
  if (saveTimer) clearInterval(saveTimer);
  saveToDisk();
  if (db) {
    db.close();
    db = null;
  }
}

// Compatibility wrapper: mimics better-sqlite3 API so all modules work unchanged
class StmtWrapper {
  constructor(sql) { this.sql = sql; this.db = db; }
  run(...params) { this.db.run(this.sql, params); return this; }
  get(...params) { return dbGet(this.sql, params); }
  all(...params) { return dbAll(this.sql, params); }
}

class DbWrapper {
  prepare(sql) { return new StmtWrapper(sql); }
  exec(sql) { if (db) db.run(sql); }
  pragma(s) { if (db) db.run(`PRAGMA ${s}`); }
}

let wrapperInstance = new DbWrapper();
export function getDb() { return wrapperInstance; }

// Internal helpers (not for external use with the wrapper)
function dbGet(sql, params = []) {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free();
  return null;
}

function dbAll(sql, params = []) {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

export function dbRun(sql, params = []) {
  if (!db) throw new Error('Database not initialized');
  db.run(sql, params);
}

function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function magnitude(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dotProduct(a, b) / (magA * magB);
}
