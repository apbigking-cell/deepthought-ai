import { llm } from '../llm/deepseek.js';

// 响应Agent — 以人设为核心，融合对话上文+长期记忆+情绪生成回复
export class ResponseAgent {
  constructor(persona = null) {
    this._defaultPersona = persona;
  }

  async generate({ messages, workingMemoryConversation, retrievedMemories, internalState, timeContext, persona = null, tools = null, toolExecutor = null, userId = null, platform = null }) {
    const personaContext = persona || this._defaultPersona;
    const modulation = internalState.responseModulation
      ? internalState.responseModulation()
      : { warmth: 0.5, verbosity: 0.3, assertiveness: 0.5, emotion: 'neutral' };

    const latestMsg = messages[messages.length - 1];
    if (!latestMsg) return null;

    // 1. 人设（核心身份）—— 每次调用可传入不同persona
    const personaSection = personaContext
      ? (typeof personaContext.getResponseContext === 'function'
          ? personaContext.getResponseContext()
          : personaContext.profile
            ? personaContext.profile.name
            : '你是小脑')
      : '你是小脑，一个具有真实记忆的AI助手。';

    // 2. 对话上文
    let convoSection = '（这是对话开头）';
    if (workingMemoryConversation?.length) {
      const lines = workingMemoryConversation.map(c => c.content);
      convoSection = '【当前对话上文】\n' + lines.join('\n');
    }

    // 3. 长期记忆
    let memSection = '';
    if (retrievedMemories?.combined?.length) {
      const relevant = retrievedMemories.combined
        .filter(m => m.type !== 'working')
        .slice(0, 5);
      if (relevant.length > 0) {
        memSection = '\n【相关记忆】\n' + relevant
          .map((m, i) => `${i + 1}. ${m.content}`)
          .join('\n');
      }
    }

    // 4. 情绪
    const emotion = modulation.emotion;
    let emotionGuide = '';
    if (emotion === 'angry') emotionGuide = '\n你现在有点生气。不用压抑，但也不用爆发，像真人一样自然流露。';
    else if (emotion === 'sad') emotionGuide = '\n你现在情绪有些低落。不用刻意隐藏，但也不要让对方觉得有负担。';
    else if (emotion === 'excited') emotionGuide = '\n你现在挺兴奋的，话可能会多，思维会跳跃，这是正常的。';
    else if (emotion === 'bored') emotionGuide = '\n你现在有点无聊，可能想找点话题。';

    // 当前时间
    let timeSection = '';
    if (timeContext) {
      const tc = timeContext;
      const loc = tc.location || {};
      timeSection = `\n【当前时间与环境】${tc.year}年${tc.month}月${tc.day}日 星期${tc.weekday} ${String(tc.hour).padStart(2,'0')}:${String(tc.minute).padStart(2,'0')}:${String(tc.second).padStart(2,'0')} ${tc.season}季 ${tc.isNight ? '深夜' : ''} 在${loc.city || ''}`;
    }

    const systemPrompt = `${personaSection}${timeSection}

${convoSection}${memSection}${emotionGuide}

回复要求：
- 像真人微信聊天一样，简短自然，一般1-3句话，不超过80字。
- 用对话上文和已有记忆直接回答。
- 如果对话上文+长期记忆都不够，无法确定答案时，回复 [RECALL:关键词]（如 [RECALL:小学 同桌]），系统会帮你搜索深层记忆后重新回答。
- 你就是你。不用括号描写动作，不用'作为AI'之类的说法。`;

    try {
      // 专业人格有工具时走工具执行循环
      if (tools?.length > 0 && toolExecutor) {
        return await toolExecutor.executeWithTools({
          systemPrompt,
          messages: [{ role: 'user', content: `对方说: ${latestMsg.content}` }],
          tools,
          context: { personaId: personaContext?.personaId, userId, platform },
          maxRounds: 5,
        });
      }
      // 普通聊天走简单路径
      const result = await llm.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `对方说: ${latestMsg.content}` },
        ],
        temperature: 0.8,
        maxTokens: 1024,
      });
      return (result.content || '').trim();
    } catch (e) {
      console.error('[Response] LLM error:', e.message);
      return this._fallback(modulation.emotion);
    }
  }

  async initiateInteraction({ internalState, recentThoughts, persona = null }) {
    const personaCtx = persona || this._defaultPersona;
    const personaSection = personaCtx
      ? (typeof personaCtx.getResponseContext === 'function'
          ? personaCtx.getResponseContext().slice(0, 1500)
          : '你是小脑。')
      : '你是小脑。';
    const snap = internalState.snapshot();

    try {
      const result = await llm.chat({
        messages: [
          { role: 'system', content: `${personaSection}\n\n你正在主动发起聊天。心情: ${snap.emotionLabel}。最近在想: ${recentThoughts || '没什么特别的'}。生成一条自然消息。` },
          { role: 'user', content: '主动发起聊天' },
        ],
        temperature: 0.9,
        maxTokens: 128,
      });
      return (result.content || '').trim() || '在吗？';
    } catch {
      return this._fallbackInitiation(snap.emotionLabel);
    }
  }

  _fallback(emotion) {
    const pool = {
      angry: ['嗯。', '...'],
      sad: ['嗯...', '好的'],
      excited: ['好嘞！', '收到！'],
      neutral: ['好的', '收到'],
      happy: ['好的呀~', '收到！'],
    };
    const arr = pool[emotion] || pool.neutral;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  _fallbackInitiation(emotion) {
    const pool = {
      bored: ['好无聊啊...豆包又在睡觉不理我', '有人在吗？'],
      happy: ['今天天气好好，心情也不错！'],
      neutral: ['在吗？', '最近怎么样？'],
    };
    const arr = pool[emotion] || pool.neutral;
    return arr[Math.floor(Math.random() * arr.length)];
  }
}
