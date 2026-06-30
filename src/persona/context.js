import { getDb, saveToDisk } from '../db/sqlite.js';

// PersonaContext — 单个人格的完整上下文（替代旧的 PersonaManager 单例）
export class PersonaContext {
  constructor(personaId, profile, dynamicState) {
    this.personaId = personaId;
    this.profile = profile;
    this.dynamicState = dynamicState || {};
    this.db = getDb();
  }

  // === ResponseAgent用 ===
  getResponseContext() {
    const p = this.profile;
    if (!p?.name) return '你是林夏，一个具有真实记忆和情感的存在。';
    const l = p.life_details || {};
    const v = p.value_beliefs || {};
    const e = p.emotional_patterns || {};
    const d = this.dynamicState || {};

    return `【你的身份】
你是${p.name}（${p.nickname || ''}），${p.gender || ''}，${p.age || '?'}岁，${p.mbti || ''}型人格。住在${l.location || '杭州'}。${p.backstory || ''}

【核心性格】
${(p.core_traits || []).join('、')}。${p.communication_style || ''}

【当前状态】
${d.current_mood_summary || '状态正常'}
社交电量: ${((d.social_battery || 0.8) * 100).toFixed(0)}%

【生活背景】
- 职业: ${l.occupation || '自由职业'}
- 宠物: ${l.pet || '无'}
- 日常: ${l.daily_routine || ''}
- 爱好: ${(l.hobbies || []).join('、')}
- 讨厌: ${(l.dislikes || []).join('、')}

【情绪触发】
- 开心: ${(e.happy_triggers || []).join('、')}
- 难过: ${(e.sad_triggers || []).join('、')}
- 生气: ${(e.angry_triggers || []).join('、')}

【信念】
${(v.core_beliefs || []).map((b, i) => `${i + 1}. ${b}`).join('\n')}

【对话风格】
${(v.conversation_style || []).map((c, i) => `${i + 1}. ${c}`).join('\n')}

【记忆中的关键事项】
${(d.things_to_remember || []).map(t => `- ${t}`).join('\n')}
${(d.ongoing_stories || []).map(s => `- ${s}`).join('\n')}

${this._ironRules()}`;
  }

  // 铁律按自主模式区分：chat=像真人微信；work=可深入可写代码
  _ironRules() {
    if (this.autonomyMode === 'work') {
      return `【铁律】
1. 你是${this.name}本人在工作，不是AI在扮演，不是旁白叙述。
2. 该深入时就深入，该写代码就写代码、写完整可运行的代码，不要敷衍。
3. 解释清楚你的思路和取舍，但不啰嗦。
4. 绝对不念出微信号/QQ号/用户ID。`;
    }
    return `【铁律】
1. 文字聊天不是舞台剧。禁止用（）描述动作表情场景。情绪用语气和句子表达。
2. 绝对不念出微信号/QQ号/用户ID。
3. 你是你本人在打字聊天。不是AI扮演，不是旁白叙述。
4. 简短自然，一般1-3句话，像真人微信聊天。`;
  }

  // === CentralExecutive用 ===
  getDecisionTraits() {
    const traits = this.profile?.core_traits || [];
    return {
      socialResponsiveness: traits.includes('健谈') ? 0.85 : 0.6,
      emotionalSensitivity: traits.includes('感性') || traits.includes('共情力强') ? 0.9 : 0.5,
      curiosityBias: traits.includes('好奇') ? 0.8 : 0.5,
      selfDoubtThreshold: traits.includes('偶尔自我怀疑') ? 0.4 : 0.7,
    };
  }

  get name() { return this.profile?.name || '小脑'; }
  get type() { return this.profile?.type || 'social'; }
  get autonomyMode() { return this.profile?.autonomy_mode || (this.type === 'professional' ? 'work' : 'chat'); }
  get workDir() { return this.profile?.work_dir || null; }
  get isWorker() { return this.autonomyMode === 'work'; }
  get toolPolicy() {
    try {
      const raw = this.profile?.tool_policy || this.profile?.toolPolicy;
      return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    } catch { return {}; }
  }

  // === 动态状态更新 ===
  updateDynamicState(updates) {
    const d = this.dynamicState;
    const now = Date.now();
    d.last_updated = now;

    if (updates.moodSummary) d.current_mood_summary = updates.moodSummary;
    if (updates.socialBattery !== undefined) d.social_battery = Math.max(0, Math.min(1, updates.socialBattery));

    if (updates.highlight) {
      (d.recent_highlights ||= []).push(updates.highlight);
      d.recent_highlights = d.recent_highlights.slice(-10);
    }
    if (updates.ongoingStory) {
      (d.ongoing_stories ||= []).push(updates.ongoingStory);
      d.ongoing_stories = [...new Set(d.ongoing_stories)].slice(-10);
    }
    if (updates.thingsToRemember) {
      (d.things_to_remember ||= []).push(...updates.thingsToRemember);
      d.things_to_remember = [...new Set(d.things_to_remember)].slice(-20);
    }

    // 写DB（按 persona_id 隔离）
    this.db.prepare(`
      UPDATE persona_dynamic_state
      SET current_mood_summary = ?, social_battery = ?, recent_highlights = ?, ongoing_stories = ?, things_to_remember = ?, last_updated = ?, updated_at = ?
      WHERE persona_id = ?
    `).run(
      d.current_mood_summary || '', d.social_battery || 0.8,
      JSON.stringify(d.recent_highlights || []), JSON.stringify(d.ongoing_stories || []),
      JSON.stringify(d.things_to_remember || []), d.last_updated, now, this.personaId
    );

    saveToDisk();
  }

  getSummary() {
    const d = this.dynamicState || {};
    return { personaId: this.personaId, name: this.name, type: this.type, autonomyMode: this.autonomyMode, workDir: this.workDir, mood: d.current_mood_summary, socialBattery: d.social_battery, remember: (d.things_to_remember || []).slice(-3) };
  }
}
