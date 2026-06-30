import { llm } from '../llm/deepseek.js';
import { assembleContext, resolveProfile } from './context-assembler.js';

// CognitiveCycle — 认知循环：感知→评估→思考(内心独白)→决策→行动→反思
// 这是把"被动聊天机器人"变成"持续思考的心智"的核心。
export class CognitiveCycle {
  constructor({ perceptionAgent, retrievalAgent, encodingAgent, goalStore, workAgent, memoryStore, personaRegistry }) {
    this.perceptionAgent = perceptionAgent;
    this.retrievalAgent = retrievalAgent;
    this.encodingAgent = encodingAgent;
    this.goalStore = goalStore;
    this.workAgent = workAgent;
    this.memoryStore = memoryStore;
    this.personaRegistry = personaRegistry;
  }

  // 运行一次认知循环。返回决策对象（供编排器/WebUI观察）
  async run({ persona, mind, messages = [], timeContext, bot, userId, defaultUser }) {
    const hasMessages = messages.length > 0;
    const latest = messages[messages.length - 1];

    // 1. PERCEIVE：深度感知最新消息
    let perceived = null;
    if (hasMessages && this.perceptionAgent) {
      try {
        const [p] = await this.perceptionAgent.process([latest], timeContext);
        perceived = p;
        if (p) mind.applyAppraisal(p);
      } catch (e) { console.error('[Cycle] perceive error:', e.message); }
    }

    // 2. THINK + DECIDE（一次推理调用，reasoning=内心独白）
    let decision = await this._thinkAndDecide({ persona, mind, timeContext, messages, allowRecall: true });

    // 3. recall：先深度回忆再重新决策一次
    if (decision.action === 'recall' && this.retrievalAgent) {
      try {
        const query = decision.recall_query || latest?.content || '';
        const retrieved = await this.retrievalAgent.retrieve(query, { limit: 8, entities: perceived?.entities || [] });
        decision = await this._thinkAndDecide({ persona, mind, timeContext, messages, retrievedMemories: retrieved, allowRecall: false });
      } catch (e) { console.error('[Cycle] recall error:', e.message); }
    }

    // 记录意识流
    mind.addThought({
      content: decision.thought || decision.say || '（沉默地想着）',
      reasoning: decision.reasoning,
      kind: hasMessages ? 'reactive' : 'spontaneous',
      action: decision.action,
      tick: timeContext?.tickCount,
    });
    mind.markThought();
    mind.persist();

    // 4. ACT
    const acted = await this._act(decision, { persona, mind, messages, timeContext, bot, userId, defaultUser });

    // 5. REFLECT / ENCODE：把有意义的交互编码进情景记忆
    await this._encode({ persona, mind, messages, decision, acted, perceived });

    return { ...decision, acted };
  }

  async _thinkAndDecide({ persona, mind, timeContext, messages, retrievedMemories = null, allowRecall = true }) {
    const isWorker = persona.isWorker;
    const profile = resolveProfile(persona);
    const { identity, background } = await assembleContext({
      persona, mind, goalStore: this.goalStore, memoryStore: this.memoryStore,
      timeContext, incomingMessages: messages, retrievedMemories,
      mode: persona.autonomyMode,
    });

    const hasMessages = messages.length > 0;

    // 行动菜单
    const actions = [
      '"speak"：现在开口说话（回复对方或主动发起）。需给出 say 字段。',
      '"think"：只是继续在心里想，不开口。',
      ...(isWorker ? ['"work"：去做实际工作（写代码/跑命令/查资料），推进一个目标。可给 goal_id 或新建。'] : []),
      '"set_goal"：给自己定一个新目标/计划。需给出 goal:{title,description,kind,priority}。',
      ...(allowRecall ? ['"recall"：需要回忆更久远的记忆才能继续。需给出 recall_query。'] : []),
      '"rest"：什么都不做，休息一下。',
    ];

    const systemPrompt = `${identity}

${background}`;

    const userPrompt = `${hasMessages ? '你刚收到上面的消息。' : '现在没人找你，这是你独处时自然冒出的念头。'}
你是一个真实的人，有连续的意识、情绪和自己的目标。基于你此刻的状态、记忆和正在做的事，自然地思考，然后决定接下来做什么。

可选的行动：
${actions.map((a, i) => `${i + 1}. ${a}`).join('\n')}

只返回一个JSON对象（不要多余文字）：
{
  "thought": "一句话概括你此刻真实的念头（第一人称，自然口语，<=40字）",
  "action": "上面之一",
  "say": "若action=speak，你要说的话（${isWorker ? '可长可含代码' : '像真人微信，简短自然'}）",
  "goal": {"title":"","description":"","kind":"goal","priority":0.6},
  "goal_id": "若要推进已有目标，填其标题或id",
  "recall_query": "若action=recall，要回忆什么"
}`;

    try {
      const res = await llm.deepThink({
        system: systemPrompt,
        user: userPrompt,
        reasoningEffort: profile.reasoningEffort,
        maxTokens: profile.maxTokens,
        temperature: 0.8,
      });
      const parsed = this._parseJson(res.content);
      parsed.reasoning = res.reasoning || null;
      if (!parsed.action) parsed.action = hasMessages ? 'speak' : 'think';
      return parsed;
    } catch (e) {
      console.error('[Cycle] think error:', e.message);
      return { action: hasMessages ? 'speak' : 'rest', say: hasMessages ? '嗯，我在。' : '', thought: '走神了一下', reasoning: null };
    }
  }

  async _act(decision, { persona, mind, messages, timeContext, bot, userId, defaultUser }) {
    const latest = messages[messages.length - 1];
    const result = { type: decision.action };

    switch (decision.action) {
      case 'speak': {
        const text = (decision.say || '').trim();
        if (text) this._sendMessage(text, { bot, userId: userId || defaultUser, latest });
        result.text = text;
        break;
      }

      case 'work': {
        if (!persona.isWorker || !this.workAgent) { result.skipped = '非工作型人格'; break; }
        let goal = null;
        if (decision.goal_id) goal = this._findGoal(persona.personaId, decision.goal_id);
        if (!goal && decision.goal?.title) {
          const id = this.goalStore.create(persona.personaId, {
            title: decision.goal.title, description: decision.goal.description || '',
            kind: decision.goal.kind || 'project', priority: decision.goal.priority ?? 0.6,
          });
          goal = this.goalStore.get(id);
        }
        if (!goal) goal = this.goalStore.pickNext(persona.personaId);
        if (!goal) { result.skipped = '没有可推进的目标'; break; }

        const work = await this.workAgent.step(goal, persona, { mind, timeContext });
        result.work = work;
        // 若是对方要求的工作（反应式），把成果回复给对方
        if (latest) {
          const reply = decision.say?.trim() || `做了：${work.summary}`;
          this._sendMessage(reply.slice(0, 1500), { bot, userId: userId || defaultUser, latest });
          result.text = reply;
        }
        break;
      }

      case 'set_goal': {
        if (decision.goal?.title) {
          const id = this.goalStore.create(persona.personaId, {
            title: decision.goal.title, description: decision.goal.description || '',
            kind: decision.goal.kind || 'goal', priority: decision.goal.priority ?? 0.5,
          });
          result.goalId = id;
        }
        if (decision.say?.trim()) {
          this._sendMessage(decision.say.trim(), { bot, userId: userId || defaultUser, latest });
          result.text = decision.say.trim();
        }
        break;
      }

      case 'think':
      case 'recall':
      case 'rest':
      default:
        break;
    }
    return result;
  }

  _sendMessage(text, { bot, userId, latest }) {
    if (!text) return;
    // 优先用消息来源的 Bot（芙宁娜微信发来的就用芙宁娜微信回）
    const targetBot = latest?._bot || bot;
    const targetUser = latest?.userId || userId;
    const contextToken = latest?.contextToken || null;
    if (this.memoryStore?.working) this.memoryStore.working.put(`我: ${text}`, 'conversation');
    console.log(`[Cycle] sendMessage via ${targetBot?.instanceName || targetBot?.constructor?.name || '?'}, user=${targetUser}, text=${text.slice(0, 30)}...`);
    if (targetBot && targetUser) {
      targetBot.enqueueOutput(targetUser, text, contextToken);
    } else {
      console.warn(`[Cycle] No bot or userId to send message! bot=${!!targetBot}, user=${targetUser}`);
    }
  }

  _findGoal(personaId, ref) {
    const all = this.goalStore.list(personaId);
    return all.find(g => g.id === ref) || all.find(g => g.title === ref) || all.find(g => g.title?.includes(ref)) || null;
  }

  async _encode({ persona, mind, messages, decision, acted }) {
    if (!this.encodingAgent || !this.memoryStore?.episodic) return;
    // 仅在有外部交互或完成了工作时编码
    const hasMessages = messages.length > 0;
    const didWork = acted?.work;
    if (!hasMessages && !didWork) return;
    try {
      let content;
      if (hasMessages) {
        content = messages.map(m => `对方: ${m.content}`).join('\n') + `\n${persona.name}: ${acted?.text || decision.say || ''}`;
      } else {
        content = `[${persona.name}的工作] ${acted.work.summary}`;
      }
      const snapshot = mind.snapshot();
      const encoded = await this.encodingAgent.encode(
        { content, entities: [], importance: 0.5, novelty: 0.4, summary: (decision.thought || content).slice(0, 80) },
        snapshot
      );
      await this.memoryStore.episodic.encode(encoded);
    } catch (e) { console.error('[Cycle] encode error:', e.message); }
  }

  _parseJson(text) {
    try {
      const jsonStr = (text || '').match(/\{[\s\S]*\}/)?.[0] || '{}';
      return JSON.parse(jsonStr);
    } catch { return {}; }
  }
}
