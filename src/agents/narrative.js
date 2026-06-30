import { llm } from '../llm/deepseek.js';

// 叙事Agent — 将碎片记忆组织为连贯叙事，同步更新人设动态状态
export class NarrativeAgent {
  constructor(memoryStore, persona = null) {
    this.memory = memoryStore;
    this.persona = persona;
  }

  async weaveNarrative() {
    if (!this.memory.episodic) return null;

    const recent = this.memory.episodic.getRecentForReplay(20);
    if (recent.length < 3) return null;

    const personaName = this.persona?.profile?.name || '小脑';
    const personaContext = this.persona
      ? `\n人物身份: ${this.persona.profile.name}，${this.persona.profile.age}岁${this.persona.profile.gender}，${this.persona.profile.life_details?.occupation || '自由职业'}。性格: ${this.persona.profile.core_traits?.join('、') || ''}。`
      : '';

    const memText = recent.map((m, i) =>
      `[${i}] ${new Date(m.created_at).toLocaleString('zh-CN')} | ${(m.summary || m.content || '').slice(0, 100)} | 情绪:${m.valence > 0.2 ? '正面' : m.valence < -0.2 ? '负面' : '中性'}`
    ).join('\n');

    try {
      const result = await llm.quick(
        `你是${personaName}的叙事编织模块。将近期记忆组织成连贯故事线，同时更新人物状态。
${personaContext}

返回JSON:
{
  "title": "叙事主题",
  "narrative": "以第一人称讲述近期经历（自然口语化）",
  "emotional_arc": "rise/fall/stable/complex",
  "key_insights": ["感悟"],
  "open_threads": ["未了话题"],
  "persona_update": {
    "mood_summary": "20字以内描述当前状态和心情",
    "social_battery": 0.0~1.0,
    "highlights": ["近期值得记住的事件"],
    "things_to_remember": ["关于聊天对象的信息/约定/偏好", "需要跟进的事项"]
  }
}`,

        `近期记忆:\n${memText}`
      );

      const parsed = this._parseJson(result.content);

      // 存储叙事
      if (parsed.narrative && this.memory.episodic) {
        await this.memory.episodic.encode({
          content: parsed.narrative,
          summary: parsed.title || '叙事',
          valence: parsed.emotional_arc === 'rise' ? 0.5 : parsed.emotional_arc === 'fall' ? -0.3 : 0.1,
          arousal: 0.3,
          significance: 0.7,
          source: 'narrative',
          tags: ['叙事', '日记'],
        });
      }

      // 更新人设动态状态
      if (parsed.persona_update && this.persona) {
        this.persona.updateDynamicState({
          moodSummary: parsed.persona_update.mood_summary,
          socialBattery: parsed.persona_update.social_battery,
          highlight: parsed.persona_update.highlights?.[0],
          thingsToRemember: parsed.persona_update.things_to_remember,
        });
      }

      return parsed;
    } catch (e) {
      console.error('[Narrative] Error:', e.message);
      return null;
    }
  }

  _parseJson(text) {
    try {
      const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] || text;
      return JSON.parse(jsonStr);
    } catch { return {}; }
  }
}
