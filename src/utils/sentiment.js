// 轻量中文情感分析 —— 用于心跳tick快速评估，不调LLM

// 正面词库
const POSITIVE = new Set([
  '好', '棒', '赞', '爱', '喜欢', '开心', '高兴', '快乐', '漂亮', '厉害', '牛逼',
  '谢谢', '感谢', '哈哈', '嘿嘿', '嘻嘻', '不错', '完美', '优秀', '帅', '酷',
  '支持', '加油', '可爱', '温暖', '感动', '笑', '好玩', '有趣', '太棒了',
  '行', '可以', '没问题', '好的', '好呀', '好嘞', 'yes', 'ok', 'nice',
  '舒服', '爽', '满足', '期待', '喜欢', '想你', '亲', '抱抱',
]);

// 负面词库
const NEGATIVE = new Set([
  '烦', '气', '怒', '恨', '讨厌', '恶心', '垃圾', '差', '烂', '坏',
  '难过', '伤心', '哭', '悲', '惨', '疼', '痛', '累', '困',
  '无聊', '无语', '算了', '随便', '唉', '呵呵', '哦', '嗯',
  '不行', '不好', '不要', '不想', '不会', '不能', '不敢',
  '失望', '崩溃', '绝望', '焦虑', '害怕', '担心', '紧张',
  '滚', 'sb', '傻逼', '脑残', '智障', '滚蛋', '去死',
  '委屈', '孤独', '冷漠', '生气', '愤怒',
]);

// 高强度标点/符号 → arousal提升
const HIGH_AROUSAL_PAT = /[！!]{2,}|[？?]{2,}|\.{3,}|～+|🔥|⚡|💥|😡|😤|😂|🤣|😍|🥰|😭|🤬/;

// 疑问 → 轻微dominance降低（被质问）
const QUESTION_PAT = /[？?]|[吗嘛呢吧]|[为什啥怎哪谁]|是不是|能不能|可不可以/;

// 感叹 → dominance提升（表达力强）
const EXCLAMATION_PAT = /[！!]|太[一-鿿]+了|好[一-鿿]+啊|真[一-鿿]+/;

// 表情符号映射
const EMOJI_SENTIMENT = {
  '😂': 0.3, '🤣': 0.4, '😍': 0.5, '🥰': 0.6, '😊': 0.3, '😄': 0.3, '😆': 0.3,
  '😡': -0.5, '😤': -0.4, '😭': -0.3, '🤬': -0.7, '😢': -0.3, '😰': -0.3,
  '[奸笑]': 0.2, '[抠鼻]': -0.1, '[笑哭]': 0.3, '[捂脸]': 0.1, '[白眼]': -0.2,
  '[发怒]': -0.5, '[难过]': -0.3, '[呲牙]': 0.3, '[得意]': 0.3,
};

// 对单条消息做快速情感分析
export function quickSentiment(text) {
  if (!text) return { valence: 0, arousal: 0.2, dominance: 0.5 };

  let valence = 0;
  let arousal = 0.2;
  let dominance = 0.5;
  let hitCount = 0;

  // 1. 表情符号匹配
  for (const [emoji, score] of Object.entries(EMOJI_SENTIMENT)) {
    if (text.includes(emoji)) {
      valence += score;
      arousal += Math.abs(score) * 0.5;
      hitCount++;
    }
  }

  // 2. 正面词匹配
  for (const word of POSITIVE) {
    if (text.includes(word)) {
      valence += 0.15;
      hitCount++;
    }
  }

  // 3. 负面词匹配
  for (const word of NEGATIVE) {
    if (text.includes(word)) {
      valence -= 0.15;
      hitCount++;
    }
  }

  // 4. 标点/句式调整
  if (HIGH_AROUSAL_PAT.test(text)) arousal += 0.3;
  if (QUESTION_PAT.test(text)) {
    dominance -= 0.1;
    arousal += 0.1;
  }
  if (EXCLAMATION_PAT.test(text)) {
    dominance += 0.1;
    arousal += 0.1;
  }

  // 5. 消息长度代理（长消息=更投入）
  if (text.length > 50) arousal += 0.1;
  if (text.length > 100) arousal += 0.1;

  // 6. 归一化
  valence = Math.max(-1, Math.min(1, valence));
  arousal = Math.max(0, Math.min(1, arousal + (hitCount > 0 ? 0 : -0.1)));
  dominance = Math.max(0, Math.min(1, dominance));

  return { valence, arousal, dominance };
}

// 基于情感分析结果计算重要性 + 新颖度
export function quickImportance(text, sentiment) {
  let imp = 0.4;
  // 情绪强度高 → 重要
  imp += Math.abs(sentiment.valence) * 0.2;
  imp += sentiment.arousal * 0.15;
  // 长消息 → 更可能重要
  if (text.length > 50) imp += 0.1;
  if (text.length > 200) imp += 0.1;
  return Math.min(1, imp);
}
