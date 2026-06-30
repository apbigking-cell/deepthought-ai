import { llm } from '../llm/deepseek.js';

// 检索Agent — 模式补全回忆（仿人脑海马体CA3）
// 核心：用LLM将模糊消息翻译为搜索语句，然后从时间/内容/情景多维度召回
export class RetrievalAgent {
  constructor(memoryStore) {
    this.memory = memoryStore;
  }

  // 多线索融合检索（由回复Agent触发，不自动调用）
  async retrieve(userMessage, options = {}) {
    const { limit = 10, entities = [], intent = '', importance = 0.5 } = options;

    const results = {
      working: [],
      episodic: [],
      semantic: [],
      combined: [],
      searchQuery: null,
    };

    // ============================================================
    // 维度0: 模式补全——融合感知实体+对话上文生成搜索语句
    // ============================================================
    const convoChunks = this.memory.working
      ? this.memory.working.getByType?.('conversation')
        || this.memory.working.getActive()
      : [];
    const wmContext = convoChunks.map(c => c.content).join('\n');

    // 将感知实体也注入到搜索生成prompt中
    const entityHint = entities.length > 0 ? `\n感知提取的实体: ${entities.join(', ')}` : '';
    const intentHint = intent ? `\n消息意图: ${intent}` : '';

    const searchQuery = await llm.generateSearchQuery(
      userMessage + entityHint + intentHint,
      wmContext
    );
    results.searchQuery = searchQuery;

    // 融合：LLM生成的关键词 + 感知提取的实体
    const llmTerms = searchQuery.search_terms || [];
    const allTerms = [...new Set([...entities, ...llmTerms, userMessage])];
    const searchText = allTerms.join(' ');

    console.log(`[Retrieval] 消息:"${userMessage.slice(0,40)}" → 搜索:"${searchText.slice(0,60)}"`);
    console.log(`[Retrieval] 上文:${wmContext ? wmContext.slice(0,60)+'...' : '(空)'} 实体:[${entities.join(',')}] 意图:${intent||'?'}`);

    // ============================================================
    // 维度1: 工作记忆（前额叶——当前对话上文，权重最高）
    // ============================================================
    if (this.memory.working) {
      results.working = this.memory.working.getActive();
      console.log(`[Retrieval] 工作记忆: ${results.working.length} chunks`);
    }

    // ============================================================
    // 维度2: 时间近因（海马体——最近发生的事）
    // 无上下文时扩大到24小时捞回跨session记忆
    // ============================================================
    const timeWindow = wmContext ? 600000 : 86400000; // 有上文10分钟，无上文24小时
    let recentEpisodic = [];
    if (this.memory.episodic) {
      try {
        recentEpisodic = await this.memory.episodic.retrieve({
          timeRange: { start: Date.now() - timeWindow, end: Date.now() },
          limit,
        });
        console.log(`[Retrieval] 时间召回(${timeWindow/60000}min): ${recentEpisodic.length}条`);
      } catch (e) {
        console.error('[Retrieval] Time recall error:', e.message);
      }
    }

    // ============================================================
    // 维度3: 内容关键词（海马体——用LLM生成的搜索词匹配）
    // 搜索词本身也做一次全文搜索
    // ============================================================
    let keywordEpisodic = [];
    if (this.memory.episodic && searchText) {
      try {
        // 用原始消息也搜一遍，防止LLM搜索词生成太窄
        keywordEpisodic = await this.memory.episodic.retrieve({
          query: searchText + ' ' + userMessage,
          limit,
        });
        console.log(`[Retrieval] 关键词召回: ${keywordEpisodic.length}条`);
      } catch (e) {
        console.error('[Retrieval] Keyword recall error:', e.message);
      }
    }

    // 合并去重情景记忆
    const seen = new Set();
    results.episodic = [];
    for (const m of [...recentEpisodic, ...keywordEpisodic]) {
      if (!seen.has(m.id)) { seen.add(m.id); results.episodic.push(m); }
    }

    // ============================================================
    // 维度4: 语义关联（皮层——知识图谱）
    // ============================================================
    if (this.memory.semantic && allTerms.length > 0) {
      for (const term of allTerms.slice(0, 3)) {
        try {
          const triples = this.memory.semantic.queryTriples({ subject: term, limit: 2 });
          results.semantic.push(...triples);
        } catch {}
      }
    }

    // ============================================================
    // 融合排序
    // ============================================================
    results.combined = this._fuseAndRank(results);

    return results;
  }

  _fuseAndRank(results) {
    const items = [];

    // 工作记忆（对话上文）——最高权重
    for (const chunk of results.working) {
      items.push({
        type: 'working',
        content: chunk.content,
        weight: 1.0,
        source: chunk,
      });
    }

    // 情景记忆——按时间+显著性加权
    for (const mem of results.episodic) {
      const age = Date.now() - (mem.created_at || 0);
      const recencyWeight = Math.exp(-age / 600000); // 10分钟半衰
      const sigWeight = mem.significance || 0.5;

      items.push({
        type: 'episodic',
        content: mem.summary || mem.content?.slice(0, 120) || '',
        weight: recencyWeight * 0.5 + sigWeight * 0.5,
        source: mem,
      });
    }

    // 语义三元组
    for (const trip of results.semantic) {
      items.push({
        type: 'semantic',
        content: `${trip.subject} ${trip.predicate} ${trip.object}`,
        weight: (trip.confidence || 0.5) * 0.4,
        source: trip,
      });
    }

    // 按权重降序
    items.sort((a, b) => b.weight - a.weight);
    return items.slice(0, 10);
  }
}
