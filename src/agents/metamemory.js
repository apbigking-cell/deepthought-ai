import { llm } from '../llm/deepseek.js';

// 元记忆Agent — 置信度评估、冲突检测
// 对应脑区：前额叶内侧
export class MetamemoryAgent {
  constructor(memoryStore) {
    this.memory = memoryStore;
  }

  // 检查记忆一致性
  async checkConsistency() {
    if (!this.memory.meta) return { conflicts: 0 };

    const conflicted = this.memory.meta.getConflicted();
    if (conflicted.length === 0) {
      // 定期随机抽查
      return this._spotCheck();
    }

    // 有已知冲突，尝试用LLM消解
    let resolved = 0;
    for (const meta of conflicted.slice(0, 3)) {
      const resolvedFlag = await this._tryResolve(meta);
      if (resolvedFlag) resolved++;
    }

    return { conflicts: conflicted.length, resolved };
  }

  // 评估检索结果的置信度
  async evaluateRetrievalConfidence(query, retrievedMemories) {
    if (!retrievedMemories || retrievedMemories.length === 0) {
      return { confidence: 0, assessment: 'no_memory' };
    }

    const memSummary = retrievedMemories.slice(0, 5).map((m, i) =>
      `[${i}] ${m.content}`
    ).join('\n');

    try {
      const result = await llm.quick(
        `你是人脑记忆引擎的元记忆模块。评估检索到的记忆对查询的匹配度和可靠性。
返回JSON: {"confidence": 0.0~1.0, "assessment": "high/medium/low/uncertain", "reasoning": "简述理由"}`,

        `查询: ${query}\n检索到的记忆:\n${memSummary}`
      );

      const parsed = this._parseJson(result.content);
      return {
        confidence: parsed.confidence ?? 0.5,
        assessment: parsed.assessment || 'medium',
        reasoning: parsed.reasoning || '',
      };
    } catch {
      return { confidence: 0.5, assessment: 'uncertain' };
    }
  }

  async _spotCheck() {
    const { getDb } = await import('../db/sqlite.js');
    // 随机找几条语义记忆，检查是否有矛盾的三元组
    const triples = getDb().prepare(`
      SELECT * FROM semantic_triples
      WHERE confidence >= 0.3
      ORDER BY RANDOM()
      LIMIT 10
    `).all();

    if (triples.length < 4) return { conflicts: 0, spotChecked: triples.length };

    const triplesText = triples.map((t, i) =>
      `[${i}] ${t.subject} ${t.predicate} ${t.object} (confidence: ${t.confidence.toFixed(2)})`
    ).join('\n');

    try {
      const result = await llm.quick(
        `你是人脑记忆引擎的元记忆冲突检测模块。
检查以下语义三元组中是否有逻辑矛盾（如A是B但同时A不是B）。
返回JSON: {"conflicts": [{"triple_a": 0, "triple_b": 3, "description": "矛盾描述"}], "clean": true/false}`,

        triplesText
      );

      const parsed = this._parseJson(result.content);
      if (parsed.conflicts && parsed.conflicts.length > 0 && this.memory.meta) {
        for (const c of parsed.conflicts) {
          const a = triples[c.triple_a];
          const b = triples[c.triple_b];
          if (a && b) {
            // 记录冲突到两条记忆的元数据
            this._recordConflict(a.id, b.id, c.description);
            this._recordConflict(b.id, a.id, c.description);
          }
        }
      }
      return { conflicts: parsed.conflicts?.length || 0, spotChecked: triples.length };
    } catch {
      return { conflicts: 0, spotChecked: triples.length };
    }
  }

  async _tryResolve(meta) {
    // 尝试用LLM消解冲突
    const inconsistencies = JSON.parse(meta.inconsistencies || '[]');
    if (inconsistencies.length === 0) return false;

    // 获取冲突的记忆
    const { getDb } = await import('../db/sqlite.js');
    const memory = getDb().prepare('SELECT * FROM episodic_memories WHERE id = ?').get(meta.target_memory_id);
    if (!memory) return false;

    try {
      const result = await llm.quick(
        `评估这个记忆的不一致性，判断是否可以消解（可能是不同上下文、时间变化、或真正的错误）。
返回JSON: {"resolved": true/false, "new_confidence": 0.0~1.0, "reason": "简述"}`,

        `记忆: ${memory.summary || memory.content}\n已知不一致: ${JSON.stringify(inconsistencies)}`
      );

      const parsed = this._parseJson(result.content);
      if (parsed.resolved) {
        getDb().prepare('UPDATE meta_memories SET confidence = ?, inconsistencies = ? WHERE id = ?')
          .run(parsed.new_confidence || 0.5, '[]', meta.id);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async _recordConflict(memoryIdA, memoryIdB, description) {
    const { getDb } = await import('../db/sqlite.js');
    const meta = getDb().prepare('SELECT * FROM meta_memories WHERE target_memory_id = ?').get(memoryIdA);
    if (!meta) return;

    const existing = JSON.parse(meta.inconsistencies || '[]');
    existing.push({ with: memoryIdB, description, timestamp: Date.now() });
    getDb().prepare('UPDATE meta_memories SET inconsistencies = ?, updated_at = ? WHERE target_memory_id = ?')
      .run(JSON.stringify(existing), Date.now(), memoryIdA);
  }

  _parseJson(text) {
    try {
      const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] || text;
      return JSON.parse(jsonStr);
    } catch { return {}; }
  }
}
