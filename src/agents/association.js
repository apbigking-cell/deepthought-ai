import { llm } from '../llm/deepseek.js';

// 关联Agent — 发现和建立记忆间的新关联
// 对应脑区：海马体CA1 + 皮层网络
export class AssociationAgent {
  constructor(memoryStore) {
    this.memory = memoryStore;
  }

  async discover() {
    if (!this.memory.semantic || !this.memory.episodic) {
      return { links: 0 };
    }

    // 获取最近的语义三元组和新情景记忆
    const { getDb } = await import('../db/sqlite.js');
    const recentSemantic = getDb().prepare(`
      SELECT * FROM semantic_triples
      WHERE last_reinforced > ?
      ORDER BY confidence DESC
      LIMIT 20
    `).all(Date.now() - 24 * 3600 * 1000);

    const recentEpisodic = getDb().prepare(`
      SELECT * FROM episodic_memories
      WHERE created_at > ?
      ORDER BY significance DESC
      LIMIT 10
    `).all(Date.now() - 24 * 3600 * 1000);

    if (recentSemantic.length < 3 && recentEpisodic.length < 3) {
      return { links: 0 };
    }

    const context = [
      ...recentSemantic.map(t => `[语义] ${t.subject} ${t.predicate} ${t.object}`),
      ...recentEpisodic.map(m => `[情景] ${m.summary || m.content?.slice(0, 80)}`),
    ].join('\n');

    try {
      const result = await llm.quick(
        `你是人脑记忆引擎的关联发现模块。在记忆片段之间寻找隐含的关联、模式或因果关系。

对给定的记忆，发现：
- 可能有关联但尚未建立连接的记忆对
- 可以归纳的更高层模式

返回JSON:
{
  "new_links": [
    {"type": "semantic_to_semantic", "subject": "实体1", "predicate": "关系", "object": "实体2"},
    {"type": "episodic_to_semantic", "episodic_summary": "...", "triple": {"s":"","p":"","o":""}}
  ],
  "emergent_patterns": ["发现的模式描述"]
}`,

        `近期记忆:\n${context}`
      );

      const parsed = this._parseJson(result.content);
      let links = 0;

      if (parsed.new_links && this.memory.semantic) {
        for (const link of parsed.new_links) {
          if (link.type === 'semantic_to_semantic' && link.subject) {
            await this.memory.semantic.storeTriple(
              link.subject, link.predicate, link.object, 0.4
            );
            links++;
          } else if (link.type === 'episodic_to_semantic' && link.triple) {
            await this.memory.semantic.storeTriple(
              link.triple.s, link.triple.p, link.triple.o, 0.4
            );
            links++;
          }
        }
      }

      return { links, patterns: parsed.emergent_patterns || [] };
    } catch (e) {
      console.error('[Association] Error:', e.message);
      return { links: 0 };
    }
  }

  _parseJson(text) {
    try {
      const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] || text;
      return JSON.parse(jsonStr);
    } catch { return {}; }
  }
}
