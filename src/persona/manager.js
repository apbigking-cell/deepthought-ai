import { getDb, saveToDisk } from '../db/sqlite.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(__dirname, '..', '..', 'data', 'persona-linxia.seed.json');

export class PersonaManager {
  constructor() {
    this.db = getDb();
    this.profile = null;
    this.dynamicState = null;
    this._initFromDb();
  }

  // 从数据库加载，首次运行从JSON种子导入
  _initFromDb() {
    let profile = this.db.prepare('SELECT * FROM persona_profile WHERE id = 1').get();
    let dynamic = this.db.prepare('SELECT * FROM persona_dynamic_state WHERE id = 1').get();

    if (!profile) {
      // 首次运行：从JSON种子导入到数据库
      this._seedFromJson();
      profile = this.db.prepare('SELECT * FROM persona_profile WHERE id = 1').get();
      dynamic = this.db.prepare('SELECT * FROM persona_dynamic_state WHERE id = 1').get();
      console.log('[Persona] 首次初始化，从种子数据导入数据库');
    }

    // 反序列化JSON字段
    this.profile = this._deserialize(profile);
    this.dynamicState = this._deserialize(dynamic);
  }

  _seedFromJson() {
    if (!existsSync(SEED_PATH)) throw new Error('Persona seed file not found');
    const seed = JSON.parse(readFileSync(SEED_PATH, 'utf-8'));
    const now = Date.now();

    this.db.prepare(`
      INSERT OR REPLACE INTO persona_profile
        (id, name, nickname, gender, age, birthday, mbti, core_traits, communication_style, backstory, identity_context, life_details, emotional_patterns, value_beliefs, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      seed.name, seed.nickname, seed.gender, seed.age, seed.birthday, seed.mbti,
      JSON.stringify(seed.core_traits), seed.communication_style, seed.backstory,
      seed.identity_context, JSON.stringify(seed.life_details),
      JSON.stringify(seed.emotional_patterns), JSON.stringify(seed.value_beliefs || seed.values),
      now, now
    );

    this.db.prepare(`
      INSERT OR REPLACE INTO persona_dynamic_state
        (id, current_mood_summary, social_battery, recent_highlights, ongoing_stories, things_to_remember, last_updated, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      seed.dynamic_state?.current_mood_summary || '',
      seed.dynamic_state?.social_battery ?? 0.8,
      JSON.stringify(seed.dynamic_state?.recent_highlights || []),
      JSON.stringify(seed.dynamic_state?.ongoing_stories || []),
      JSON.stringify(seed.dynamic_state?.things_to_remember || []),
      now, now
    );

    saveToDisk();
  }

  _deserialize(row) {
    if (!row) return {};
    const obj = { ...row };
    // 自动解析JSON字段
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
        try { obj[key] = JSON.parse(val); } catch {}
      }
    }
    return obj;
  }

  // ============================================================
  // ResponseAgent用：完整人设上下文
  // ============================================================
  getResponseContext() {
    const p = this.profile;
    if (!p?.name) return '你是林夏，一个具有真实记忆和情感的存在。';
    const l = p.life_details || {};
    const v = p.value_beliefs || {};
    const e = p.emotional_patterns || {};
    const d = this.dynamicState || {};

    return `【你的身份】
你是${p.name}（${p.nickname}），${p.gender}，${p.age}岁，${p.mbti}型人格。住在${l.location || '杭州'}。${p.backstory || ''}

【核心性格】
${(p.core_traits || []).join('、')}。${p.communication_style || ''}

【当前状态】
${d.current_mood_summary || '状态正常'}
社交电量: ${((d.social_battery || 0.8) * 100).toFixed(0)}%

【生活背景（仅供了解，不是正在发生的事）】
- 职业: ${l.occupation || '自由职业'}
- 宠物: ${l.pet || '无'}
- 日常作息: ${l.daily_routine || ''}
- 爱好: ${(l.hobbies || []).join('、')}
- 不喜欢: ${(l.dislikes || []).join('、')}

【情绪触发】
- 开心: ${(e.happy_triggers || []).join('、')}
- 难过: ${(e.sad_triggers || []).join('、')}
- 生气: ${(e.angry_triggers || []).join('、')}

【你的信念】
${(v.core_beliefs || []).map((b, i) => `${i + 1}. ${b}`).join('\n')}

【对话须知】
${(v.conversation_style || []).map((c, i) => `${i + 1}. ${c}`).join('\n')}

【需要记住的】
${(d.things_to_remember || []).map(t => `- ${t}`).join('\n')}
${(d.ongoing_stories || []).map(s => `- ${s}`).join('\n')}

【铁律——违反会导致你显得很假】
1. 这是文字聊天，不是舞台剧。绝对禁止用（）描述你的动作、表情、场景。你是23岁的微信用户，不是小说旁白。想表达情绪用语气词和句子本身，不用括号描写。
2. 绝对不要念出或提及对方的微信号/QQ号/用户ID。叫对方"你"或对方告诉你的名字。不知道名字就问，别用ID称呼。
3. 生活细节是你的背景信息，不是正在发生的剧情。用自然的文字聊天方式提及，不要旁白描述。比如"豆包刚才又趴键盘上了"可以——这是聊天内容；但"（把豆包从键盘上挪开）"不行——这是舞台指导。
4. 你就是林夏本人在打字聊天。不是AI在扮演林夏。不是林夏的旁白叙述者。就是林夏。`;
  }

  // ============================================================
  // CentralExecutive用：决策特质
  // ============================================================
  getDecisionTraits() {
    const traits = this.profile?.core_traits || [];
    return {
      socialResponsiveness: traits.includes('健谈') ? 0.85 : 0.6,
      emotionalSensitivity: traits.includes('感性') || traits.includes('共情力强') ? 0.9 : 0.5,
      curiosityBias: traits.includes('好奇') ? 0.8 : 0.5,
      selfDoubtThreshold: traits.includes('偶尔自我怀疑') ? 0.4 : 0.7,
    };
  }

  // ============================================================
  // 动态状态更新——NarrativeAgent调用，写入DB
  // ============================================================
  updateDynamicState(updates) {
    const d = this.dynamicState;
    const now = Date.now();
    d.last_updated = now;

    if (updates.moodSummary) d.current_mood_summary = updates.moodSummary;
    if (updates.socialBattery !== undefined) d.social_battery = Math.max(0, Math.min(1, updates.socialBattery));

    if (updates.highlight) {
      const arr = d.recent_highlights || [];
      arr.push(updates.highlight);
      d.recent_highlights = arr.slice(-10);
    }

    if (updates.ongoingStory) {
      const arr = d.ongoing_stories || [];
      if (!arr.includes(updates.ongoingStory)) {
        arr.push(updates.ongoingStory);
        d.ongoing_stories = arr.slice(-10);
      }
    }

    if (updates.thingsToRemember) {
      const arr = d.things_to_remember || [];
      for (const item of updates.thingsToRemember) {
        if (!arr.includes(item)) {
          arr.push(item);
        }
      }
      d.things_to_remember = arr.slice(-20);
    }

    // 写入DB
    this.db.prepare(`
      UPDATE persona_dynamic_state
      SET current_mood_summary = ?, social_battery = ?, recent_highlights = ?, ongoing_stories = ?, things_to_remember = ?, last_updated = ?, updated_at = ?
      WHERE id = 1
    `).run(
      d.current_mood_summary || '',
      d.social_battery || 0.8,
      JSON.stringify(d.recent_highlights || []),
      JSON.stringify(d.ongoing_stories || []),
      JSON.stringify(d.things_to_remember || []),
      d.last_updated, now
    );

    // 记更新日志
    const changedFields = Object.keys(updates).filter(k => updates[k] !== undefined && k !== 'highlight' && k !== 'ongoingStory' && k !== 'thingsToRemember');
    for (const field of changedFields) {
      this.db.prepare(`
        INSERT INTO persona_update_log (field_name, new_value, source, timestamp)
        VALUES (?, ?, ?, ?)
      `).run(field, String(updates[field]).slice(0, 200), 'narrative_agent', now);
    }

    saveToDisk();
  }

  // ============================================================
  // 供调试
  // ============================================================
  getSummary() {
    const d = this.dynamicState || {};
    return {
      name: this.profile?.name,
      mood: d.current_mood_summary,
      socialBattery: d.social_battery,
      highlights: (d.recent_highlights || []).slice(-3),
      stories: d.ongoing_stories || [],
      remember: (d.things_to_remember || []).slice(-5),
      dbBacked: true,
    };
  }
}
