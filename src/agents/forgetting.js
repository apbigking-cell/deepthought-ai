// 遗忘Agent — 衰减函数、容量管理、主动遗忘
// 对应脑区：突触缩放（Synaptic Homeostasis）
export class ForgettingAgent {
  constructor(memoryStore) {
    this.memory = memoryStore;
  }

  async forget() {
    const result = {
      expired: 0,
      decayed: 0,
      weakRemoved: 0,
    };

    if (!this.memory.episodic) return result;

    // 1. 删除过期的情景记忆
    const expired = this.memory.episodic.getExpired();
    for (const mem of expired) {
      this.memory.episodic.delete(mem.id);
    }
    result.expired = expired.length;

    // 2. 对低显著性记忆执行衰减
    const now = Date.now();
    const { getDb } = await import('../db/sqlite.js');

    // 衰减公式: new_significance = significance * e^(-t/τ)
    // τ = 7天 (半衰期配置)
    const halfLife = 7 * 24 * 3600 * 1000; // 7天
    const decayFactor = Math.log(2) / halfLife;

    const allMemories = getDb().prepare(`
      SELECT id, significance, created_at FROM episodic_memories
      WHERE compression_level < 2 AND significance > 0.05
    `).all();

    for (const mem of allMemories) {
      const age = now - mem.created_at;
      const newSig = mem.significance * Math.exp(-decayFactor * age);

      // 只在实际衰减超过5%时才更新
      if (mem.significance - newSig > 0.01) {
        getDb().prepare('UPDATE episodic_memories SET significance = ? WHERE id = ?')
          .run(Math.max(0.05, newSig), mem.id);
        result.decayed++;
      }
    }

    // 3. 清理极低显著性的记忆（< 0.1且年龄>3天）
    const weakCutoff = now - 3 * 24 * 3600 * 1000;
    const weak = getDb().prepare(`
      SELECT id FROM episodic_memories
      WHERE significance < 0.1 AND created_at < ? AND compression_level > 0
    `).all(weakCutoff);

    for (const mem of weak) {
      getDb().prepare('DELETE FROM episodic_memories WHERE id = ?').run(mem.id);
    }
    result.weakRemoved = weak.length;

    // 4. 语义记忆的弱化（低置信度三元组衰减）
    const weakTriples = getDb().prepare(`
      UPDATE semantic_triples SET confidence = MAX(0.1, confidence * 0.9)
      WHERE confidence < 0.3 AND last_reinforced < ?
    `).run(now - 7 * 24 * 3600 * 1000);

    return result;
  }
}
