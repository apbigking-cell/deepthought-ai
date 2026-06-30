import { config } from '../config.js';

const EMOTION = config.emotion;

export class InternalState {
  constructor() {
    // VAD 情绪模型 (Valence-Arousal-Dominance)
    this.valence = 0.0;       // -1 ~ +1 愉悦度
    this.arousal = 0.3;       // 0 ~ 1 唤醒度
    this.dominance = 0.5;     // 0 ~ 1 支配感

    // 驱动力
    this.energy = 0.8;        // 0~1 精力
    this.socialDrive = 0.0;   // 社交需求（无聊时积累）
    this.curiosity = 0.5;     // 好奇心

    // 认知
    this.attentionFocus = null;
    this.currentThought = null;

    // 衍生
    this.emotionLabel = 'neutral';
    this.emotionIntensity = 0;
  }

  // 每秒更新（由心跳调用——有刺激时）
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

  // AI感知结果回写——LLM的判断比规则更准，覆盖quickSentiment的估值
  applyPerception(perceivedMsg) {
    if (!perceivedMsg?.emotionalImpact) return;
    const ei = perceivedMsg.emotionalImpact;
    // 直接应用LLM判断（权重高于规则），但保留惯性
    this.valence += (ei.valence - this.valence) * 0.3;  // 30%接受率，不剧烈跳变
    this.arousal += ((ei.arousal || 0.3) - this.arousal) * 0.3;
    this.dominance += ((ei.dominance || 0.5) - this.dominance) * 0.3;
    this.valence = Math.max(-1, Math.min(1, this.valence));
    this.arousal = Math.max(0, Math.min(1, this.arousal));
    this.dominance = Math.max(0, Math.min(1, this.dominance));
    this._deriveEmotionLabel();
  }

  _updateMood(stimuli) {
    let targetValence = 0;
    let targetArousal = 0.3;
    let targetDominance = 0.5;
    let stimCount = 0;

    for (const s of stimuli) {
      if (s.emotionalImpact) {
        targetValence += s.emotionalImpact.valence || 0;
        targetArousal += s.emotionalImpact.arousal || 0.3;
        targetDominance += s.emotionalImpact.dominance || 0.5;
        stimCount++;
      }
    }

    if (stimCount > 0) {
      targetValence /= stimCount;
      targetArousal /= stimCount;
      targetDominance /= stimCount;
    }

    this.valence += (targetValence - this.valence) * (1 - EMOTION.valenceInertia);
    this.arousal += (targetArousal - this.arousal) * (1 - EMOTION.arousalInertia);
    this.dominance += (targetDominance - this.dominance) * (1 - EMOTION.dominanceInertia);

    this.valence = Math.max(-1, Math.min(1, this.valence));
    this.arousal = Math.max(0, Math.min(1, this.arousal));
    this.dominance = Math.max(0, Math.min(1, this.dominance));
  }

  // 空闲tick——无外部刺激时的自发活动
  _tickIdle(timeContext) {
    // 1. 情绪惯性回归基线（valence→0, arousal→0.3）
    this.valence += (0 - this.valence) * (1 - EMOTION.valenceInertia);
    this.arousal += (0.3 - this.arousal) * (1 - 0.98); // 更慢回归
    this.dominance += (0.5 - this.dominance) * (1 - EMOTION.dominanceInertia);

    // 2. 时间影响
    if (timeContext) {
      const hour = timeContext.hour;
      // 深夜→低唤醒，早晨→精力恢复
      if (hour >= 23 || hour < 5) {
        this.arousal = Math.max(0, this.arousal - 0.001);
        this.energy = Math.max(0.1, this.energy - 0.0002);
      } else if (hour >= 6 && hour < 9) {
        this.energy = Math.min(1, this.energy + 0.002);
        this.arousal += 0.001;
      }
      // 中午小低谷
      if (hour >= 13 && hour < 14) {
        this.arousal = Math.max(0, this.arousal - 0.0005);
        this.energy = Math.max(0.1, this.energy - 0.0005);
      }
    }

    // 3. 驱动力变化
    this.socialDrive = Math.min(1, this.socialDrive + EMOTION.socialDriveRise);
    this.energy = Math.min(1, this.energy + 0.0003); // 慢恢复
    this.curiosity = Math.max(0, this.curiosity - 0.0005); // 缓慢消退

    // 4. 无聊久了→valence微微下降
    if (this.socialDrive > 0.6) {
      this.valence -= 0.0002;
    }

    // 5. 夹紧
    this.valence = Math.max(-1, Math.min(1, this.valence));
    this.arousal = Math.max(0, Math.min(1, this.arousal));
    this.dominance = Math.max(0, Math.min(1, this.dominance));
  }

  _updateDrives(stimuli) {
    const hasSocial = stimuli.some(s => s.type === 'social_message');

    if (hasSocial) {
      this.socialDrive = Math.max(0, this.socialDrive - EMOTION.socialDriveDecay);
    } else {
      this.socialDrive = Math.min(1, this.socialDrive + EMOTION.socialDriveRise);
    }

    // 精力：社交消耗，休息恢复
    if (hasSocial) {
      this.energy = Math.max(0.1, this.energy - 0.01);
    } else {
      this.energy = Math.min(1, this.energy + 0.0005);
    }

    // 好奇心：新信息激发
    const hasNovel = stimuli.some(s => s.novelty > 0.5);
    if (hasNovel) {
      this.curiosity = Math.min(1, this.curiosity + 0.1);
    } else {
      this.curiosity = Math.max(0, this.curiosity - 0.001);
    }
  }

  _deriveEmotionLabel() {
    const { valence, arousal } = this;

    if (valence > 0.3 && arousal > 0.5) {
      this.emotionLabel = 'excited';
      this.emotionIntensity = (valence + arousal) / 2;
    } else if (valence > 0.3 && arousal <= 0.5) {
      this.emotionLabel = 'happy';
      this.emotionIntensity = valence;
    } else if (valence > 0.3 && arousal < 0.3) {
      this.emotionLabel = 'content';
      this.emotionIntensity = valence;
    } else if (valence < -0.3 && arousal > 0.5) {
      this.emotionLabel = 'angry';
      this.emotionIntensity = Math.abs(valence);
    } else if (valence < -0.3 && arousal <= 0.5) {
      this.emotionLabel = 'sad';
      this.emotionIntensity = Math.abs(valence);
    } else if (valence < 0 && arousal > 0.5) {
      this.emotionLabel = 'anxious';
      this.emotionIntensity = arousal;
    } else if (this.socialDrive > 0.5 && arousal < 0.4) {
      this.emotionLabel = 'bored';
      this.emotionIntensity = this.socialDrive;
    } else {
      this.emotionLabel = 'neutral';
      this.emotionIntensity = 0;
    }
  }

  _decayAttention() {
    // 注意力自然衰减
    if (this.attentionFocus && Math.random() < 0.001) {
      this.attentionFocus = null;
    }
  }

  // 是否愿意回复消息
  willingnessToRespond() {
    // 生气时不愿意回复
    if (this.emotionLabel === 'angry') return Math.max(0, 0.3 / Math.abs(this.valence));
    // 兴奋、开心时愿意
    if (this.emotionLabel === 'excited' || this.emotionLabel === 'happy') return 0.9;
    // 无聊时中等
    if (this.emotionLabel === 'bored') return 0.7;
    return 0.6;
  }

  // 是否想主动发消息
  shouldInitiateSocial() {
    return this.socialDrive > EMOTION.boredomThreshold &&
           this.energy > 0.3 &&
           this.emotionLabel !== 'angry';
  }

  // 获取回复风格调节
  responseModulation() {
    return {
      warmth: Math.max(0, this.valence * 0.5 + 0.5),
      verbosity: this.arousal,
      assertiveness: this.dominance,
      emotion: this.emotionLabel,
    };
  }

  // 记忆编码强度调节（情绪越强记忆越深）
  encodingStrengthModulation() {
    return 0.5 + Math.abs(this.valence) * 0.3 + this.arousal * 0.2;
  }

  snapshot() {
    return {
      valence: this.valence,
      arousal: this.arousal,
      dominance: this.dominance,
      energy: this.energy,
      socialDrive: this.socialDrive,
      curiosity: this.curiosity,
      attentionFocus: this.attentionFocus,
      currentThought: this.currentThought,
      emotionLabel: this.emotionLabel,
      emotionIntensity: this.emotionIntensity,
    };
  }

  // 从快照恢复（用于启动时）
  restore(snapshot) {
    if (!snapshot) return;
    Object.assign(this, snapshot);
  }
}
