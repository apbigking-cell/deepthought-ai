import { config } from '../config.js';

const COG = config.cognition;

// Scheduler — 决定每个心跳哪些 Mind 该跑认知循环
// 反应式：有消息/到期意图立即思考；自发式：按节律(受唤醒/好奇/待办加速)
export class Scheduler {
  due(mind, { hasMessages = false, pendingIntentions = false, pendingGoals = false, now = Date.now() } = {}) {
    if (hasMessages) return true;
    if (pendingIntentions) return true;

    const m = mind.snapshot();
    const base = COG.spontaneousThinkMs;
    const min = COG.minThinkMs;
    // 唤醒度/好奇心/有待办 → 思考更频繁
    const accel = Math.min(1, m.arousal * 0.4 + m.curiosity * 0.3 + (pendingGoals ? 0.4 : 0));
    let interval = base - (base - min) * accel;
    if (m.energy < 0.2) interval *= 2;        // 累了少想
    if (m.emotionLabel === 'bored') interval *= 0.7; // 无聊多想
    return (now - (mind.lastThinkAt || 0)) >= interval;
  }
}
