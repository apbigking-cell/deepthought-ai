import { llm } from '../llm/deepseek.js';
import { quickSentiment } from '../utils/sentiment.js';

// 感知Agent — 将原始刺激转化为结构化感知
// 对应脑区：感觉皮层 + 初级加工
export class PerceptionAgent {
  async process(stimuli, timeContext) {
    // 如果没有需要深度处理的刺激，快速路径
    const socialMsgs = stimuli.filter(s => s.type === 'social_message');
    if (socialMsgs.length === 0) {
      // 非社交刺激（时间信息、系统事件等）——情感影响中性
      return stimuli.map(s => ({
        ...s,
        emotionalImpact: { valence: 0, arousal: 0, dominance: 0.5 },
        novelty: 0,
        importance: 0.1,
        summary: null,
        entities: [],
        intent: null,
      }));
    }

    // 有一条或多条社交消息，用LLM深度解析
    const prompt = buildPerceptionPrompt(socialMsgs, timeContext);

    try {
      const result = await llm.quick(prompt.system, prompt.user);
      return this._mergeResults(stimuli, socialMsgs, result);
    } catch (e) {
      console.error('[Perception] LLM error:', e.message);
      // 降级：用轻量情感分析替代固定值
      return stimuli.map(s => {
        const sentiment = quickSentiment(s.content || '');
        return {
          ...s,
          emotionalImpact: sentiment,
          novelty: 0.3,
          importance: 0.4,
          summary: s.content?.slice(0, 50) || null,
          entities: s.type === 'social_message' ? [] : [],
          intent: s.type === 'social_message' ? 'unknown' : null,
        };
      });
    }
  }

  _mergeResults(allStimuli, socialMsgs, llmResult) {
    let parsed = [];
    try {
      const content = llmResult.content || '';
      const jsonStr = content.match(/\[[\s\S]*\]/)?.[0]
        || content.match(/\{[\s\S]*\}/)?.[0]
        || content;
      parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) parsed = [parsed];
    } catch {
      // LLM解析失败 → 基础规则提取
    }

    // 构建匹配映射（兼容 msg_id 和 id 两种字段名）
    const parsedMap = new Map();
    for (const p of parsed) {
      const key = p.msg_id || p.id;
      if (key) parsedMap.set(key, p);
    }

    // 如果LLM没返回任何结果，用规则兜底（情感不再是固定0）
    if (parsedMap.size === 0) {
      for (const m of socialMsgs) {
        const sentiment = quickSentiment(m.content);
        parsedMap.set(m.id, {
          emotionalImpact: sentiment,
          novelty: 0.4,
          importance: 0.5,
          summary: m.content?.slice(0, 80),
          entities: this._basicEntityExtract(m.content),
          intent: this._basicIntentDetect(m.content),
        });
      }
    }

    return allStimuli.map(s => {
      if (s.type === 'social_message' && parsedMap.has(s.id)) {
        const p = parsedMap.get(s.id);
        return {
          ...s,
          emotionalImpact: p.emotionalImpact || { valence: 0, arousal: 0.2, dominance: 0.5 },
          novelty: p.novelty ?? 0.4,
          importance: p.importance ?? 0.5,
          summary: p.summary || s.content?.slice(0, 100),
          entities: p.entities || [],
          intent: p.intent || 'unknown',
        };
      }
      return {
        ...s,
        emotionalImpact: { valence: 0, arousal: 0, dominance: 0.5 },
        novelty: 0,
        importance: 0.1,
        summary: null,
        entities: [],
        intent: null,
      };
    });
  }

  // 基础实体提取（不依赖LLM）
  _basicEntityExtract(text) {
    const entities = [];
    // 中文人名：2-3字中文 + 常见称呼
    const namePat = /[一-鿿]{2,3}(?:先生|女士|老师|同学)?/g;
    const matches = text.match(namePat) || [];
    for (const m of matches) if (m.length >= 2) entities.push(m);
    // 常见话题词
    const topics = ['名字', '年龄', '工作', '学习', '恋爱', '游戏', '电影', '音乐', '旅游', '美食', '运动', '编程'];
    for (const t of topics) if (text.includes(t)) entities.push(t);
    return [...new Set(entities)].slice(0, 5);
  }

  // 基础意图检测（不依赖LLM）
  _basicIntentDetect(text) {
    if (/[？?]/.test(text)) return 'question';
    if (/[！!]/.test(text)) return 'exclamation';
    if (/谢谢|感谢|多谢/.test(text)) return 'thanks';
    if (/好吧|嗯|哦|知道了/.test(text)) return 'acknowledgment';
    if (/命令|帮|做|写|查|搜/.test(text)) return 'command';
    return 'chat';
  }
}

function buildPerceptionPrompt(msgs, timeContext) {
  const tc = timeContext || {};
  const loc = tc.location || {};
  const dateStr = `${tc.year || '?'}年${tc.month || '?'}月${tc.day || '?'}日`;
  const timeStr = `${String(tc.hour || 0).padStart(2, '0')}:${String(tc.minute || 0).padStart(2, '0')}:${String(tc.second || 0).padStart(2, '0')}`;
  const seasonMap = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
  const seasonStr = seasonMap[tc.season] || '';

  const contextInfo = [
    `日期: ${dateStr} 星期${tc.weekday || '?'}`,
    `时间: ${timeStr}${tc.isNight ? '（深夜）' : ''}`,
    `季节: ${seasonStr}`,
    `地点: ${loc.country || ''} ${loc.region || ''} ${loc.city || ''}`,
  ].join('\n');

  const msgsText = msgs.map(m =>
    `[msg_id:${m.id}] ${m.username}: ${m.content}`
  ).join('\n');

  return {
    system: `你是人脑记忆引擎的感知模块。将社交消息解析为结构化感知。

环境信息:
${contextInfo}

对每条消息，分析：
- emotionalImpact: 情绪影响 {valence: -1~1, arousal: 0~1, dominance: 0~1}
- novelty: 0~1 新颖程度
- importance: 0~1 重要性
- summary: 一句话概括（不超过30字）
- entities: 关键实体（人名、事物、概念）
- intent: 意图 (question/greeting/sharing/command/complaint/emotion/other)

返回严格JSON数组。`,

    user: msgsText,
  };
}
