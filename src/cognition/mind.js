import { config } from '../config.js';
import { getDb } from '../db/sqlite.js';

const EMOTION = config.emotion;

// Mind — 单个人格的心智状态：情绪(VAD) + 驱动力 + 注意力 + 意识流
// 每个人格独立持有一个 Mind（替代旧的全局 InternalState 单例）
export class Mind {
  constructor(personaId, autonomyMode = 'chat') {
    this.personaId = personaId;
    this.autonomyMode = autonomyMode;
    this.db = getDb();

    // VAD 情绪
    this.valence = 0.0;
    this.arousal = 0.3;
    this.dominance = 0.5;

    // 驱动力
    this.energy = 0.8;
    this.socialDrive = 0.0;
    this.curiosity = 0.5;

    // 认知
    this.attentionFocus = null;
    this.currentThought = null;
    this.emotionLabel = 'neutral';
    this.emotionIntensity = 0;

    // 节律
    this.lastThinkAt = 0;

    // 意识流缓冲（内存中最近若干条内心独白，启动时从DB回填）
    this.thoughtBuffer = [];

    this._restore();
  }

  _restore() {
    try {
      const row = this.db.prepare('SELECT * FROM persona_state WHERE persona_id = ?').get(this.personaId);
      if (row) {
        this.valence = row.valence ?? this.valence;
        this.arousal = row.arousal ?? this.arousal;
        this.dominance = row.dominance ?? this.dominance;
        this.energy = row.energy ?? this.energy;
        this.socialDrive = row.social_drive ?? this.socialDrive;
        this.curiosity = row.curiosity ?? this.curiosity;
        this.attentionFocus = row.attention_focus || null;
        this.currentThought = row.current_thought || null;
        this.emotionLabel = row.emotion_label || 'neutral';
        this.lastThinkAt = row.last_think_at || 0;
      } else {
        this._persist();
      }
      // 回填最近意识流
      const thoughts = this.db.prepare(
        'SELECT content, reasoning, kind, created_at FROM thought_stream WHERE persona_id = ? ORDER BY created_at DESC LIMIT 12'
      ).all(this.personaId);
      this.thoughtBuffer = thoughts.reverse().map(t => ({ content: t.content, kind: t.kind, at: t.created_at }));
    } catch (e) {
      console.error('[Mind] restore error:', e.message);
    }
  }

  // 情绪/驱动力每tick更新
  tick(stimuli = [], timeContext = null) {
    if (stimuli.length > 0) {
      this._updateMood(stimuli);
      this._updateDrives(stimuli);
    } else {
      this._tickIdle(timeContext);
    }
    this._deriveEmotionLabel();
    this._decayAttention();
    return this.snapshot();
  }

  // LLM感知结果回写
  applyAppraisal(perceivedMsg) {
    if (!perceivedMsg?.emotionalImpact) return;
    const ei = perceivedMsg.emotionalImpact;
    this.valence += (ei.valence - this.valence) * 0.3;
    this.arousal += ((ei.arousal || 0.3) - this.arousal) * 0.3;
    this.dominance += ((ei.dominance || 0.5) - this.dominance) * 0.3;
    this._clamp();
    this._deriveEmotionLabel();
  }

  // 记录一条内心独白（意识流）
  addThought({ content, reasoning = null, kind = 'spontaneous', action = null, tick = null }) {
    if (!content) return;
    const now = Date.now();
    this.currentThought = content;
    this.thoughtBuffer.push({ content, kind, at: now });
    if (this.thoughtBuffer.length > 30) this.thoughtBuffer.shift();
    try {
      this.db.prepare(`
        INSERT INTO thought_stream (persona_id, tick, kind, content, reasoning, action, valence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(this.personaId, tick, kind, content, reasoning ? String(reasoning).slice(0, 8000) : null, action, this.valence, now);
    } catch (e) {
      console.error('[Mind] addThought error:', e.message);
    }
  }

  recentThoughts(n = 12) {
    return this.thoughtBuffer.slice(-n);
  }

  markThought(now = Date.now()) {
    this.lastThinkAt = now;
  }

  _updateMood(stimuli) {
    let tv = 0, ta = 0.3, td = 0.5, n = 0;
    for (const s of stimuli) {
      if (s.emotionalImpact) {
        tv += s.emotionalImpact.valence || 0;
        ta += s.emotionalImpact.arousal || 0.3;
        td += s.emotionalImpact.dominance || 0.5;
        n++;
      }
    }
    if (n > 0) { tv /= n; ta /= n; td /= n; }
    this.valence += (tv - this.valence) * (1 - EMOTION.valenceInertia);
    this.arousal += (ta - this.arousal) * (1 - EMOTION.arousalInertia);
    this.dominance += (td - this.dominance) * (1 - EMOTION.dominanceInertia);
    this._clamp();
  }

  _tickIdle(timeContext) {
    this.valence += (0 - this.valence) * (1 - EMOTION.valenceInertia);
    this.arousal += (0.3 - this.arousal) * (1 - 0.98);
    this.dominance += (0.5 - this.dominance) * (1 - EMOTION.dominanceInertia);

    if (timeContext) {
      const hour = timeContext.hour;
      if (hour >= 23 || hour < 5) {
        this.arousal = Math.max(0, this.arousal - 0.001);
        this.energy = Math.max(0.1, this.energy - 0.0002);
      } else if (hour >= 6 && hour < 9) {
        this.energy = Math.min(1, this.energy + 0.002);
        this.arousal += 0.001;
      }
      if (hour >= 13 && hour < 14) {
        this.arousal = Math.max(0, this.arousal - 0.0005);
        this.energy = Math.max(0.1, this.energy - 0.0005);
      }
    }

    this.socialDrive = Math.min(1, this.socialDrive + EMOTION.socialDriveRise);
    this.energy = Math.min(1, this.energy + 0.0003);
    this.curiosity = Math.max(0, this.curiosity - 0.0005);
    if (this.socialDrive > 0.6) this.valence -= 0.0002;
    this._clamp();
  }

  _updateDrives(stimuli) {
    const hasSocial = stimuli.some(s => s.type === 'social_message');
    if (hasSocial) {
      this.socialDrive = Math.max(0, this.socialDrive - EMOTION.socialDriveDecay);
      this.energy = Math.max(0.1, this.energy - 0.01);
    } else {
      this.socialDrive = Math.min(1, this.socialDrive + EMOTION.socialDriveRise);
      this.energy = Math.min(1, this.energy + 0.0005);
    }
    const hasNovel = stimuli.some(s => s.novelty > 0.5);
    if (hasNovel) this.curiosity = Math.min(1, this.curiosity + 0.1);
    else this.curiosity = Math.max(0, this.curiosity - 0.001);
  }

  _deriveEmotionLabel() {
    const { valence, arousal } = this;
    if (valence > 0.3 && arousal > 0.5) { this.emotionLabel = 'excited'; this.emotionIntensity = (valence + arousal) / 2; }
    else if (valence > 0.3 && arousal <= 0.5) { this.emotionLabel = 'happy'; this.emotionIntensity = valence; }
    else if (valence < -0.3 && arousal > 0.5) { this.emotionLabel = 'angry'; this.emotionIntensity = Math.abs(valence); }
    else if (valence < -0.3 && arousal <= 0.5) { this.emotionLabel = 'sad'; this.emotionIntensity = Math.abs(valence); }
    else if (valence < 0 && arousal > 0.5) { this.emotionLabel = 'anxious'; this.emotionIntensity = arousal; }
    else if (this.socialDrive > 0.5 && arousal < 0.4) { this.emotionLabel = 'bored'; this.emotionIntensity = this.socialDrive; }
    else { this.emotionLabel = 'neutral'; this.emotionIntensity = 0; }
  }

  _decayAttention() {
    if (this.attentionFocus && Math.random() < 0.001) this.attentionFocus = null;
  }

  _clamp() {
    this.valence = Math.max(-1, Math.min(1, this.valence));
    this.arousal = Math.max(0, Math.min(1, this.arousal));
    this.dominance = Math.max(0, Math.min(1, this.dominance));
    this.energy = Math.max(0, Math.min(1, this.energy));
    this.socialDrive = Math.max(0, Math.min(1, this.socialDrive));
    this.curiosity = Math.max(0, Math.min(1, this.curiosity));
  }

  willingnessToRespond() {
    if (this.emotionLabel === 'angry') return Math.max(0, 0.3 / Math.max(0.01, Math.abs(this.valence)));
    if (this.emotionLabel === 'excited' || this.emotionLabel === 'happy') return 0.9;
    if (this.emotionLabel === 'bored') return 0.7;
    return 0.6;
  }

  shouldInitiateSocial() {
    return this.socialDrive > EMOTION.boredomThreshold && this.energy > 0.3 && this.emotionLabel !== 'angry';
  }

  responseModulation() {
    return {
      warmth: Math.max(0, this.valence * 0.5 + 0.5),
      verbosity: this.arousal,
      assertiveness: this.dominance,
      emotion: this.emotionLabel,
    };
  }

  encodingStrengthModulation() {
    return 0.5 + Math.abs(this.valence) * 0.3 + this.arousal * 0.2;
  }

  snapshot() {
    return {
      personaId: this.personaId,
      valence: this.valence, arousal: this.arousal, dominance: this.dominance,
      energy: this.energy, socialDrive: this.socialDrive, curiosity: this.curiosity,
      attentionFocus: this.attentionFocus, currentThought: this.currentThought,
      emotionLabel: this.emotionLabel, emotionIntensity: this.emotionIntensity,
      lastThinkAt: this.lastThinkAt,
    };
  }

  _persist() {
    const now = Date.now();
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO persona_state
          (persona_id, valence, arousal, dominance, energy, social_drive, curiosity, emotion_label, attention_focus, current_thought, last_think_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.personaId, this.valence, this.arousal, this.dominance, this.energy,
        this.socialDrive, this.curiosity, this.emotionLabel,
        this.attentionFocus, this.currentThought, this.lastThinkAt, now
      );
    } catch (e) {
      console.error('[Mind] persist error:', e.message);
    }
  }

  persist() { this._persist(); }
}

// MindRegistry — 管理所有人格的 Mind
export class MindRegistry {
  constructor() {
    this.minds = new Map();
  }

  get(personaId, autonomyMode = 'chat') {
    if (!this.minds.has(personaId)) {
      this.minds.set(personaId, new Mind(personaId, autonomyMode));
    }
    return this.minds.get(personaId);
  }

  all() { return [...this.minds.values()]; }

  persistAll() { for (const m of this.minds.values()) m.persist(); }
}
