import { getDb } from '../db/sqlite.js';

// 前瞻记忆Agent — "记住要去做某事"
// 对应脑区：前额叶 + 顶叶
export class ProspectiveAgent {
  constructor() {
    this.intentions = []; // [{ id, description, trigger, created, deadline }]
    this.db = getDb();
  }

  // 设立一个意图
  setIntention(description, trigger = null, deadline = null) {
    const intention = {
      id: `int_${Date.now()}`,
      description,
      trigger,    // 触发条件描述文本
      created: Date.now(),
      deadline,   // 绝对时间戳
      fulfilled: false,
    };
    this.intentions.push(intention);
    return intention.id;
  }

  // 每秒心跳检查：有没有该触发/到期的意图
  check(timeContext) {
    const triggered = [];

    for (const intent of this.intentions) {
      if (intent.fulfilled) continue;

      let shouldTrigger = false;

      // 基于deadline的触发
      if (intent.deadline && Date.now() >= intent.deadline) {
        shouldTrigger = true;
      }

      // 基于条件的触发（简单关键词匹配）
      if (intent.trigger && timeContext) {
        const contextStr = JSON.stringify(timeContext).toLowerCase();
        if (contextStr.includes(intent.trigger.toLowerCase())) {
          shouldTrigger = true;
        }
      }

      if (shouldTrigger) {
        triggered.push(intent);
        intent.fulfilled = true;
      }
    }

    // 清理已完成的意图
    this.intentions = this.intentions.filter(i => !i.fulfilled);

    return triggered;
  }

  // 获取所有待完成的意图
  getPending() {
    return this.intentions.filter(i => !i.fulfilled);
  }

  // 从消息中自动提取意图
  async extractIntentions(message) {
    // 简单的规则提取
    const patterns = [
      { regex: /(?:提醒我|别忘了|记得)(.+?)(?:在|的|时|时候|以后|之后|前|之前|，|。|$)/g, type: 'reminder' },
      { regex: /(?:明天|后天|下周|下个月|过几天|等[一会下])/g, type: 'future_time' },
      { regex: /(?:要|想|打算|计划|准备)(?:去|做|弄)(.+?)(?:了|的|，|。|$)/g, type: 'plan' },
    ];

    const extracted = [];
    for (const pattern of patterns) {
      const matches = message.matchAll(pattern.regex);
      for (const match of matches) {
        extracted.push({
          type: pattern.type,
          content: match[1] || match[0],
          fromMessage: message,
        });
      }
    }

    // 把提取的提醒意图注册
    for (const item of extracted) {
      if (item.type === 'reminder' || item.type === 'plan') {
        this.setIntention(item.content, null, null);
      }
    }

    return extracted;
  }
}
