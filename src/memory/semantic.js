import { v4 as uuid } from 'uuid';
import { getDb, cosineSimilarity } from '../db/sqlite.js';
import { llm } from '../llm/deepseek.js';

// L3 语义记忆 — 颞叶皮层，三元组 + 向量，知识图谱
export class SemanticMemory {
  constructor() {
    this.db = getDb();
  }

  // 存储三元组
  async storeTriple(subject, predicate, object, confidence = 1.0, episodicIds = []) {
    // 检查是否已有相同三元组
    const existing = this.db.prepare(
      'SELECT * FROM semantic_triples WHERE subject = ? AND predicate = ? AND object = ?'
    ).get(subject, predicate, object);

    if (existing) {
      // 强化已有记忆
      this.db.prepare(`
        UPDATE semantic_triples
        SET confidence = MIN(1.0, confidence + ?),
            last_reinforced = ?,
            source_episodic_ids = ?
        WHERE id = ?
      `).run(confidence * 0.3, Date.now(), JSON.stringify(episodicIds), existing.id);
      return existing.id;
    }

    const id = uuid();
    const text = `${subject} ${predicate} ${object}`;
    let embedding = null;
    try {
      const vec = await llm.embed(text);
      embedding = Buffer.from(new Float32Array(vec).buffer);
    } catch {}

    this.db.prepare(`
      INSERT INTO semantic_triples (id, subject, predicate, object, confidence, embedding, source_episodic_ids, created_at, last_reinforced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, subject, predicate, object, confidence, embedding, JSON.stringify(episodicIds), Date.now(), Date.now());

    return id;
  }

  // 查询三元组
  queryTriples({ subject, predicate, object, minConfidence = 0.3, limit = 20 }) {
    const conditions = ['1=1'];
    const params = [];

    if (subject) { conditions.push('subject = ?'); params.push(subject); }
    if (predicate) { conditions.push('predicate = ?'); params.push(predicate); }
    if (object) { conditions.push('object = ?'); params.push(object); }

    conditions.push('confidence >= ?');
    params.push(minConfidence);
    params.push(limit);

    return this.db.prepare(`
      SELECT * FROM semantic_triples
      WHERE ${conditions.join(' AND ')}
      ORDER BY confidence DESC
      LIMIT ?
    `).all(...params);
  }

  // 语义搜索（向量相似度）
  async search(query, limit = 10) {
    let queryVec;
    try {
      const vec = await llm.embed(query);
      queryVec = new Float32Array(vec);
    } catch {
      return this._textSearch(query, limit);
    }

    const all = this.db.prepare('SELECT * FROM semantic_triples WHERE confidence >= 0.3 LIMIT 1000').all();

    const scored = all.map(t => {
      if (!t.embedding) return { ...t, score: 0 };
      const tripVec = new Float32Array(t.embedding.buffer);
      return { ...t, score: cosineSimilarity(queryVec, tripVec) };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // 获取与某实体相关的所有三元组（子图检索）
  getEntitySubgraph(entityName, depth = 1) {
    const results = new Set();
    const frontier = [entityName];

    for (let d = 0; d < depth; d++) {
      const nextFrontier = new Set();
      for (const entity of frontier) {
        const triples = this.db.prepare(`
          SELECT * FROM semantic_triples
          WHERE subject = ? OR object = ?
          AND confidence >= 0.3
          LIMIT 50
        `).all(entity, entity);

        for (const t of triples) {
          results.add(t);
          nextFrontier.add(t.subject);
          nextFrontier.add(t.object);
        }
      }
      frontier.length = 0;
      frontier.push(...nextFrontier);
    }

    return [...results];
  }

  _textSearch(query, limit) {
    const like = `%${query}%`;
    return this.db.prepare(`
      SELECT * FROM semantic_triples
      WHERE (subject LIKE ? OR predicate LIKE ? OR object LIKE ?) AND confidence >= 0.3
      LIMIT ?
    `).all(like, like, like, limit);
  }
}
