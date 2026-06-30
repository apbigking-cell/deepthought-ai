import { v4 as uuid } from 'uuid';
import { getDb, saveToDisk } from '../db/sqlite.js';
import { llm } from '../llm/deepseek.js';
import { config } from '../config.js';

// L2 情景记忆 — 海马体模拟
// 检索策略：关键词匹配 + 时间范围 + LLM相关性排序（DeepSeek无embedding API）
export class EpisodicMemory {
  constructor() {
    this.db = getDb();
    this.retentionMs = config.memory.episodicRetentionDays * 24 * 3600 * 1000;
  }

  // 编码新的情景记忆
  async encode({ content, summary, valence = 0, arousal = 0, significance = null, source = 'direct', tags = [] }) {
    const id = uuid();
    const now = Date.now();

    if (significance === null) {
      significance = this._computeSignificance({ valence, arousal, content });
    }

    const stmt = this.db.prepare(`
      INSERT INTO episodic_memories (id, content, summary, embedding, valence, arousal, significance, source, created_at, expires_at, tags)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id, content, summary || content.slice(0, 200),
      valence, arousal, significance, source,
      now, now + this.retentionMs, JSON.stringify(tags)
    );

    // 每次编码后立即持久化
    saveToDisk();

    return { id, significance };
  }

  // 检索情景记忆
  // 策略：关键词匹配 → 时间范围兜底 → LLM相关性排序
  async retrieve({ query = null, timeRange = null, minSignificance = 0, limit = 10, tags = null }) {
    const now = Date.now();
    let memories = [];

    // 1. 时间范围检索（总是执行，确保近期对话可召回）
    const recentStart = timeRange?.start || (now - 600000); // 默认10分钟
    const recentEnd = timeRange?.end || now;

    const timeResults = this.db.prepare(`
      SELECT * FROM episodic_memories
      WHERE created_at >= ? AND created_at <= ?
      AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(recentStart, recentEnd, now, limit);

    // 合并已获取的id
    const seen = new Set();
    for (const m of timeResults) {
      seen.add(m.id);
      memories.push(m);
    }

    // 2. 文本关键词搜索
    if (query && memories.length < limit) {
      // 对查询分词（简单按字拆+双字组合）
      const terms = this._extractSearchTerms(query);
      const remaining = limit - memories.length;

      // 对每个关键词做LIKE搜索
      for (const term of terms.slice(0, 5)) {
        if (memories.length >= limit) break;
        const textResults = this.db.prepare(`
          SELECT * FROM episodic_memories
          WHERE (content LIKE ? OR summary LIKE ?)
          AND expires_at > ?
          ORDER BY significance DESC, created_at DESC
          LIMIT ?
        `).all(`%${term}%`, `%${term}%`, now, remaining);

        for (const m of textResults) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            memories.push(m);
          }
        }
      }
    }

    // 3. 如果结果较多，用LLM做语义相关性排序
    if (query && memories.length > 3) {
      try {
        memories = await this._llmRelevanceRank(query, memories, limit);
      } catch {
        // 降级：按显著性和时间排序
        memories.sort((a, b) => (b.significance || 0) - (a.significance || 0) || b.created_at - a.created_at);
        memories = memories.slice(0, limit);
      }
    } else {
      memories.sort((a, b) => b.created_at - a.created_at);
      memories = memories.slice(0, limit);
    }

    // 更新访问记录
    for (const m of memories) {
      if (m.id) {
        this.db.prepare('UPDATE episodic_memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?')
          .run(Date.now(), m.id);
      }
    }

    return memories;
  }

  // LLM语义相关性排序
  async _llmRelevanceRank(query, candidates, topN) {
    const candidateText = candidates.map((m, i) =>
      `[${i}] ${(m.summary || m.content || '').slice(0, 150)}`
    ).join('\n');

    const result = await llm.quick(
      `你是记忆检索相关性评估器。判断哪些记忆与查询相关。
返回JSON: {"relevant":[3,0,7]} 按相关性从高到低排列索引。只返回真正相关的。`,

      `查询: ${query}\n\n候选记忆:\n${candidateText}`
    );

    try {
      const jsonStr = (result.content || '').match(/\{[\s\S]*\}/)?.[0] || '{}';
      const { relevant = [] } = JSON.parse(jsonStr);
      return relevant.map(i => candidates[i]).filter(Boolean).slice(0, topN);
    } catch {
      return candidates.slice(0, topN);
    }
  }

  // 中文分词（简单：单字+双字+三字组合）
  _extractSearchTerms(text) {
    const cleaned = text.replace(/[^一-鿿\w]/g, '');
    const terms = new Set();

    // 单字
    for (const c of cleaned) terms.add(c);

    // 双字组合
    for (let i = 0; i < cleaned.length - 1; i++) {
      terms.add(cleaned.slice(i, i + 2));
    }

    // 三字组合
    for (let i = 0; i < cleaned.length - 2; i++) {
      terms.add(cleaned.slice(i, i + 3));
    }

    // 去太短的
    return [...terms].filter(t => t.length >= 2 || /[\w]/.test(t)).slice(0, 10);
  }

  getById(id) {
    return this.db.prepare('SELECT * FROM episodic_memories WHERE id = ?').get(id);
  }

  markCompressed(id, compressedToId) {
    this.db.prepare('UPDATE episodic_memories SET compression_level = compression_level + 1 WHERE id = ?')
      .run(id);
  }

  getCompressible(olderThanMs = null) {
    const cutoff = olderThanMs || this.retentionMs;
    return this.db.prepare(`
      SELECT * FROM episodic_memories
      WHERE created_at < ? AND compression_level = 0 AND expires_at > ?
      ORDER BY significance ASC
      LIMIT 20
    `).all(Date.now() - cutoff, Date.now());
  }

  getExpired() {
    return this.db.prepare('SELECT * FROM episodic_memories WHERE expires_at <= ?').all(Date.now());
  }

  delete(id) {
    this.db.prepare('DELETE FROM episodic_memories WHERE id = ?').run(id);
  }

  getRecentForReplay(limit = 50) {
    return this.db.prepare(`
      SELECT * FROM episodic_memories WHERE expires_at > ?
      ORDER BY created_at DESC LIMIT ?
    `).all(Date.now(), limit);
  }

  _computeSignificance({ valence, arousal, content }) {
    let sig = 0.5; // 基准提高到0.5，确保不被过滤
    sig += Math.abs(valence) * 0.3;
    sig += arousal * 0.15;
    if (content?.length > 200) sig += 0.1;
    return Math.min(1, sig);
  }
}
