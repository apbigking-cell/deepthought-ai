import { llm } from '../llm/deepseek.js';

// 压缩Agent — 将具体情景记忆逐层抽象为语义知识
// 对应脑区：皮层语义化（去上下文化）
export class CompressionAgent {
  constructor(memoryStore) {
    this.memory = memoryStore;
  }

  async compress() {
    if (!this.memory.episodic || !this.memory.semantic) {
      return { compressed: 0, triples: 0 };
    }

    // 获取需要压缩的旧记忆
    const candidates = this.memory.episodic.getCompressible();
    if (candidates.length === 0) return { compressed: 0, triples: 0 };

    // 每次压缩最多处理5条
    const batch = candidates.slice(0, 5);

    const memText = batch.map((m, i) =>
      `[${i}] ${m.summary || m.content?.slice(0, 150)} (${new Date(m.created_at).toISOString()})`
    ).join('\n');

    let triples = 0;

    try {
      const result = await llm.quick(
        `你是人脑记忆引擎的压缩模块，模拟大脑皮层对情景记忆的去上下文化过程。
将具体事件抽象为语义三元组(subject-predicate-object)和高层摘要。

对每条记忆：
- 压缩为更简洁的摘要（去除时间、地点等具体细节，保留核心信息）
- 提取1-3个语义三元组

返回JSON:
{
  "compressed": [
    {
      "original_index": 0,
      "compressed_summary": "关于XX的讨论",
      "triples": [
        {"subject": "用户", "predicate": "喜欢", "object": "XX"},
        {"subject": "项目", "predicate": "使用", "object": "YY技术"}
      ]
    }
  ]
}`,

        `待压缩记忆:\n${memText}`
      );

      const parsed = this._parseJson(result.content);
      let compressed = 0;

      if (parsed.compressed) {
        for (const item of parsed.compressed) {
          const original = batch[item.original_index];
          if (!original) continue;

          // 更新原记忆摘要
          if (item.compressed_summary) {
            const { getDb } = await import('../db/sqlite.js');
            getDb().prepare('UPDATE episodic_memories SET summary = ?, compression_level = compression_level + 1 WHERE id = ?')
              .run(item.compressed_summary, original.id);
            compressed++;
          }

          // 存储语义三元组
          if (item.triples && this.memory.semantic) {
            for (const t of item.triples) {
              await this.memory.semantic.storeTriple(
                t.subject, t.predicate, t.object,
                0.5, [original.id]
              );
              triples++;
            }
          }
        }
      }

      return { compressed, triples };
    } catch (e) {
      console.error('[Compression] Error:', e.message);
      return { compressed: 0, triples: 0 };
    }
  }

  _parseJson(text) {
    try {
      const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] || text;
      return JSON.parse(jsonStr);
    } catch { return {}; }
  }
}
