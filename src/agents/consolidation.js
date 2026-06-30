import { llm } from '../llm/deepseek.js';

// 巩固Agent — 回放近期记忆，强化重要记忆，转移到长期存储
// 对应脑区：海马体→皮层 记忆巩固（NREM睡眠期）
export class ConsolidationAgent {
  constructor(memoryStore) {
    this.memory = memoryStore;
  }

  async consolidate() {
    if (!this.memory.episodic) return { consolidated: 0, strengthened: 0 };

    // 获取需要巩固的记忆（高显著性 或 多次访问的近期记忆）
    const recent = this.memory.episodic.getRecentForReplay(50);
    if (recent.length === 0) return { consolidated: 0, strengthened: 0 };

    // 筛选需要巩固的记忆
    const toConsolidate = recent.filter(m => {
      const accessCount = m.access_count || 0;
      const significance = m.significance || 0.3;
      const age = Date.now() - m.created_at;
      // 显著性或访问频率高的记忆
      return significance > 0.5 || accessCount >= 3 || (significance > 0.3 && age < 3600000);
    });

    if (toConsolidate.length === 0) return { consolidated: 0, strengthened: 0 };

    // 使用LLM做记忆回放巩固
    const memoriesText = toConsolidate.map((m, i) =>
      `[${i}] ${m.summary || m.content?.slice(0, 100)} (sig:${(m.significance||0).toFixed(2)}, 访问:${m.access_count||0}次)`
    ).join('\n');

    try {
      const result = await llm.quick(
        `你是人脑记忆引擎的巩固模块，模拟海马体向皮层转移记忆的过程。
回顾近期记忆，判断哪些值得长期保留，并提取它们之间的关联。

返回JSON:
{
  "keep_ids": [0, 2, 5],      // 值得长期保留的记忆索引
  "strengthen_ids": [1, 3],   // 需要增强显著性的索引
  "weaken_ids": [4],          // 可降级的索引
  "discovered_links": [       // 发现的记忆间关联
    {"from": 0, "to": 2, "relation": "因果关系"},
    {"from": 1, "to": 5, "relation": "同一主题"}
  ],
  "narrative_threads": [      // 发现的叙事线
    "关于XX话题的多次讨论"
  ]
}`,

        `近期记忆回顾:\n${memoriesText}`
      );

      const parsed = this._parseJson(result.content);
      let strengthened = 0;
      let consolidated = 0;

      // 增强显著性
      if (parsed.strengthen_ids) {
        for (const idx of parsed.strengthen_ids) {
          if (toConsolidate[idx]) {
            const mem = toConsolidate[idx];
            // 更新数据库中的显著性（通过直接SQL）
            const { getDb } = await import('../db/sqlite.js');
            getDb().prepare('UPDATE episodic_memories SET significance = MIN(1.0, significance + 0.1) WHERE id = ?')
              .run(mem.id);
            strengthened++;
          }
        }
      }

      // 标记巩固
      if (parsed.keep_ids) {
        for (const idx of parsed.keep_ids) {
          if (toConsolidate[idx]) {
            // 标记为已巩固
            const { getDb } = await import('../db/sqlite.js');
            getDb().prepare('UPDATE episodic_memories SET compression_level = MAX(compression_level, 1) WHERE id = ?')
              .run(toConsolidate[idx].id);
            consolidated++;
          }
        }
      }

      // 发现的关联存入语义记忆
      if (parsed.discovered_links && this.memory.semantic) {
        for (const link of parsed.discovered_links) {
          const fromMem = toConsolidate[link.from];
          const toMem = toConsolidate[link.to];
          if (fromMem && toMem) {
            await this.memory.semantic.storeTriple(
              fromMem.summary?.slice(0, 50) || `memory_${link.from}`,
              link.relation || 'related_to',
              toMem.summary?.slice(0, 50) || `memory_${link.to}`,
              0.6,
              [fromMem.id, toMem.id]
            );
          }
        }
      }

      return {
        consolidated,
        strengthened,
        discoveredLinks: parsed.discovered_links?.length || 0,
        narrativeThreads: parsed.narrative_threads || [],
      };
    } catch (e) {
      console.error('[Consolidation] Error:', e.message);
      return { consolidated: 0, strengthened: 0, error: e.message };
    }
  }

  _parseJson(text) {
    try {
      const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] || text;
      return JSON.parse(jsonStr);
    } catch { return {}; }
  }
}
