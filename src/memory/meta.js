import { v4 as uuid } from 'uuid';
import { getDb } from '../db/sqlite.js';

// L5 元记忆 — 记忆的记忆，置信度、冲突检测、来源归因
export class MetaMemory {
  constructor() {
    this.db = getDb();
  }

  // 为记忆创建元数据
  createMeta(targetMemoryId, targetLayer, { confidence = 1.0, sourceAttribution = null } = {}) {
    const id = uuid();
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO meta_memories (id, target_memory_id, target_layer, confidence, source_attribution, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, targetMemoryId, targetLayer, confidence, sourceAttribution, now, now);

    return id;
  }

  // 更新置信度
  updateConfidence(targetMemoryId, newConfidence) {
    this.db.prepare(`
      UPDATE meta_memories SET confidence = ?, updated_at = ?
      WHERE target_memory_id = ?
    `).run(newConfidence, Date.now(), targetMemoryId);
  }

  // 记录检索事件
  recordRetrieval(targetMemoryId, success, context = {}) {
    const meta = this.getByTarget(targetMemoryId);
    if (!meta) return;

    const history = JSON.parse(meta.retrieval_history || '[]');
    history.push({
      timestamp: Date.now(),
      success,
      context: context.query || '',
    });

    // 只保留最近50次检索记录
    const trimmed = history.slice(-50);

    this.db.prepare(`
      UPDATE meta_memories SET retrieval_history = ?, updated_at = ?
      WHERE target_memory_id = ?
    `).run(JSON.stringify(trimmed), Date.now(), targetMemoryId);
  }

  // 检测记忆冲突
  async detectConflicts(targetMemoryId, content, memoryStore) {
    const meta = this.getByTarget(targetMemoryId);
    if (!meta) return [];

    const conflicts = [];

    // 检查语义层面的冲突
    if (memoryStore && memoryStore.semantic) {
      // 提取三元组并在语义记忆中查找矛盾
      // 简单的矛盾检测：寻找相同subject+predicate但不同object的三元组
      const related = memoryStore.semantic.queryTriples({});
      // 留空让外部LLM做语义冲突判断
    }

    // 记录不一致
    if (conflicts.length > 0) {
      const existingConflicts = JSON.parse(meta.inconsistencies || '[]');
      const updated = [...existingConflicts, ...conflicts];
      this.db.prepare(`
        UPDATE meta_memories SET inconsistencies = ?, updated_at = ?
        WHERE target_memory_id = ?
      `).run(JSON.stringify(updated), Date.now(), targetMemoryId);
    }

    return conflicts;
  }

  // 获取记忆元数据
  getByTarget(targetMemoryId) {
    return this.db.prepare(
      'SELECT * FROM meta_memories WHERE target_memory_id = ?'
    ).get(targetMemoryId);
  }

  // 获取低置信度记忆（需要审查）
  getLowConfidence(minConfidence = 0.5) {
    return this.db.prepare(
      'SELECT * FROM meta_memories WHERE confidence < ? ORDER BY confidence ASC'
    ).all(minConfidence);
  }

  // 获取最近有冲突的记忆
  getConflicted() {
    return this.db.prepare(`
      SELECT * FROM meta_memories
      WHERE inconsistencies != '[]' AND inconsistencies IS NOT NULL
      ORDER BY updated_at DESC
    `).all();
  }
}
