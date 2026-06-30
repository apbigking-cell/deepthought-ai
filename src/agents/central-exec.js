// 中央执行Agent — 每tick决策，受人物性格特质影响
export class CentralExecutive {
  constructor(persona = null) {
    this.persona = persona;
    this.decisionHistory = [];
    this.lastDecision = null;
    this.idleTicks = 0;
  }

  get traits() {
    return this.persona?.getDecisionTraits?.() || {
      socialResponsiveness: 0.6,
      emotionalSensitivity: 0.5,
      curiosityBias: 0.5,
      selfDoubtThreshold: 0.7,
    };
  }

  get name() {
    return this.persona?.profile?.name || '小脑';
  }

  async decide({ stimuli, internalState, workingMemory, hasPendingInput }) {
    const snap = internalState.snapshot();
    this.idleTicks = hasPendingInput ? 0 : this.idleTicks + 1;
    const t = this.traits;

    const socialMsgs = stimuli.filter(s => s.type === 'social_message');
    if (socialMsgs.length > 0) {
      const willingness = internalState.willingnessToRespond();

      // 生气+低意愿→冷处理（敏感人格更容易生气不理人）
      if (snap.emotionLabel === 'angry' && willingness < 0.4 + t.emotionalSensitivity * 0.1) {
        this._recordDecision('ignore', 'angry_cold');
        return { action: 'ignore', reason: 'too_angry', messages: [] };
      }

      // 精力过低
      if (snap.energy < 0.15) {
        this._recordDecision('defer', 'low_energy');
        return { action: 'defer', reason: 'low_energy', messages: socialMsgs };
      }

      // 外向健谈→更愿意回复
      const effectiveWillingness = Math.min(1, willingness + (t.socialResponsiveness - 0.5) * 0.2);
      if (effectiveWillingness < 0.3) {
        this._recordDecision('ignore', 'low_willingness');
        return { action: 'ignore', reason: `willingness=${effectiveWillingness.toFixed(2)}`, messages: [] };
      }

      this._recordDecision('respond', 'normal');
      return {
        action: 'respond',
        reason: `willingness=${effectiveWillingness.toFixed(2)}`,
        messages: socialMsgs,
        modulation: internalState.responseModulation(),
      };
    }

    // 无消息→好奇的人更倾向主动社交
    if (internalState.shouldInitiateSocial() && this.idleTicks > 1800) {
      const prob = snap.socialDrive * 0.02 * t.socialResponsiveness;
      if (Math.random() < prob) {
        this._recordDecision('initiate', 'boredom');
        return {
          action: 'initiate',
          reason: `social_drive=${snap.socialDrive.toFixed(2)}, idle=${this.idleTicks}`,
          modulation: internalState.responseModulation(),
        };
      }
    }

    this._recordDecision('idle', 'nothing');
    return { action: 'idle', reason: 'no stimuli' };
  }

  _recordDecision(action, reason) {
    this.lastDecision = { action, reason, timestamp: Date.now() };
    this.decisionHistory.push(this.lastDecision);
    if (this.decisionHistory.length > 100) this.decisionHistory.shift();
  }
}
