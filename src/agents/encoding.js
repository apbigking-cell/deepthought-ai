import { llm } from '../llm/deepseek.js';

// 编码Agent — 海马体齿状回（模式分离）
// 将感知结果编码为L2情景记忆，显著性由情绪+新颖度+重要性共同决定
export class EncodingAgent {
  async encode(perception, internalStateSnapshot) {
    const importance = perception.importance ?? 0.5;
    const novelty = perception.novelty ?? 0.5;

    // 所有对话都走深度编码（保证标签和摘要质量）
    return this._deepEncode(perception, internalStateSnapshot);
  }

  async _deepEncode(perception, internalStateSnapshot) {
    const content = perception.content || '';
    const moodStr = internalStateSnapshot.emotionLabel || 'neutral';

    let keywords = perception.entities || [];
    let summary = perception.summary || content.slice(0, 100);
    let tags = ['对话'];

    // 用LLM提取结构化编码
    try {
      const result = await llm.quick(
        `你是记忆编码器。提取以下对话的关键信息用于日后检索。

返回JSON:
{
  "summary": "15字以内事件摘要",
  "keywords": ["关键词1","关键词2","关键词3","关键词4"],
  "topic": "话题分类",
  "entities": ["提取的实体名"],
  "sentiment": "正面/负面/中性",
  "memorable": true/false,
  "memorable_reason": "为什么值得记住"
}`,

        `当前情绪: ${moodStr}
对话内容: ${content.slice(0, 500)}`
      );

      const parsed = this._parseJson(result.content);
      keywords = [...(parsed.keywords || []), ...(parsed.entities || [])];
      summary = parsed.summary || summary;
      tags = [parsed.topic || '对话', parsed.sentiment || '中性'];
      if (parsed.memorable) tags.push('重要');
    } catch (e) {
      console.error('[Encoding] LLM提取失败，使用基础编码:', e.message);
    }

    // 显著性计算（基准提高，受情绪和状态调制）
    const sig = this._calcSignificance(perception, internalStateSnapshot);

    return {
      content,
      summary,
      significance: sig,
      valence: internalStateSnapshot.valence || 0,
      arousal: internalStateSnapshot.arousal || 0.3,
      tags,
      shouldConsolidate: sig > 0.5,
      source: 'conversation',
    };
  }

  _calcSignificance(perception, state) {
    // 基准0.5——对话本身就有记忆价值
    let sig = 0.5;
    sig += (perception.importance || 0.5) * 0.2;
    sig += (perception.novelty || 0.3) * 0.1;
    sig += Math.abs(state.valence || 0) * 0.15;
    sig += (state.arousal || 0.3) * 0.05;
    return Math.min(1, Math.max(0.3, sig));
  }

  _parseJson(text) {
    try {
      const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] || text;
      return JSON.parse(jsonStr);
    } catch { return {}; }
  }
}
