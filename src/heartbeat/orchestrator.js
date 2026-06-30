import { config } from '../config.js';
import { getDb } from '../db/sqlite.js';
import { quickSentiment, quickImportance } from '../utils/sentiment.js';

// 心跳编排器 — 驱动每个人格的认知循环（持续思考 + 目标 + 自主工作）
export class HeartbeatOrchestrator {
  constructor(components) {
    this.components = components;

    this.tickCount = 0;
    this.isRunning = false;
    this.isSleeping = false;
    this.intervalHandle = null;
    this.db = getDb();

    this.busy = new Set();              // 正在跑认知循环的人格id
    this.pendingByPersona = new Map();  // personaId → 待处理消息
    this.lastDecision = new Map();      // personaId → 最近决策（供WebUI观察）

    this.stats = {
      ticksTotal: 0, messagesProcessed: 0, responsesGenerated: 0,
      cyclesRun: 0, thoughtsGenerated: 0, worksDone: 0,
      initiationsMade: 0, microSleeps: 0, memoriesEncoded: 0, memoriesForgotten: 0,
    };
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[Heartbeat] Starting with ${config.heartbeat.intervalMs}ms interval`);
    this.intervalHandle = setInterval(() => {
      this._tick().catch(err => console.error('[Heartbeat] Tick error:', err));
    }, config.heartbeat.intervalMs);
    console.log('[Heartbeat] Engine is ALIVE');
  }

  stop() {
    this.isRunning = false;
    if (this.intervalHandle) { clearInterval(this.intervalHandle); this.intervalHandle = null; }
    this.components.mindRegistry?.persistAll();
    console.log('[Heartbeat] Engine stopped');
  }

  async _tick() {
    const tickStart = Date.now();
    this.tickCount++;
    this.stats.ticksTotal++;

    const {
      sensoryBuffer, workingMemory, bots,
      personaRegistry, personaRouter, mindRegistry, scheduler, cognitiveCycle, goalStore,
    } = this.components;

    const timeContext = this._buildTimeContext();

    // ---- 阶段1: 收集消息并按人格路由入队 ----
    if (bots?.length) {
      for (const bot of bots) {
        if (!bot) continue;
        const msgs = bot.collectInbound?.() || [];
        for (const m of msgs) {
          m._bot = bot;
          const platform = bot.constructor?.name?.replace('Bot', '').toLowerCase() || 'terminal';
          const persona = personaRouter?.resolvePersona(platform, m.userId) || personaRegistry?.getDefault();
          const pid = persona?.personaId || personaRegistry?.defaultId;
          if (!this.pendingByPersona.has(pid)) this.pendingByPersona.set(pid, []);
          this.pendingByPersona.get(pid).push(m);
          sensoryBuffer?.write(m, 'social');
          workingMemory?.put(`[${platform}]对方(${m.username}): ${m.content}`, 'conversation');
          this.stats.messagesProcessed++;
        }
      }
    }
    sensoryBuffer?.write(timeContext, 'time');

    // ---- 阶段2: 遍历所有人格的心智，更新情绪 + 调度认知循环 ----
    const personaIds = new Set([
      ...(personaRegistry?.list().map(p => p.personaId) || []),
      ...this.pendingByPersona.keys(),
    ]);

    const now = Date.now();
    for (const pid of personaIds) {
      const persona = personaRegistry?.getPersona(pid);
      if (!persona) continue;
      const mind = mindRegistry.get(pid, persona.autonomyMode);
      const msgs = this.pendingByPersona.get(pid) || [];
      const hasMessages = msgs.length > 0;

      // 情绪更新（每tick，便宜，无LLM）
      const stimuli = msgs.map(m => {
        const sentiment = quickSentiment(m.content);
        return { type: 'social_message', content: m.content, emotionalImpact: sentiment, importance: quickImportance(m.content, sentiment), novelty: 0.3 };
      });
      mind.tick(stimuli, timeContext);

      if (this.isSleeping || this.busy.has(pid)) continue;

      const pendingGoals = goalStore ? goalStore.active(pid).length > 0 : false;
      if (scheduler.due(mind, { hasMessages, pendingGoals, now })) {
        // 消费该人格的待处理消息
        this.pendingByPersona.set(pid, []);
        this.busy.add(pid);
        this._runCycle(persona, mind, msgs, timeContext)
          .catch(e => console.error(`[Heartbeat] Cycle(${pid}) error:`, e.message))
          .finally(() => this.busy.delete(pid));
      }
    }

    // ---- 阶段3: 持久化 + 发送 ----
    if (this.tickCount % 60 === 0) mindRegistry.persistAll();
    if (bots?.length) {
      for (const bot of bots) {
        if (bot?.hasPendingOutput?.()) {
          bot.flushOutput().catch(e => console.error('[Heartbeat] Flush error:', e.message));
        }
      }
    }

    // ---- 微睡眠 ----
    if (this.tickCount > 0 && this.tickCount % config.heartbeat.microSleepIntervalTicks === 0) {
      this._triggerMicroSleep().catch(e => console.error('[Heartbeat] Micro-sleep error:', e));
    }

    const dur = Date.now() - tickStart;
    if (dur > 500) console.warn(`[Heartbeat] Slow tick #${this.tickCount}: ${dur}ms`);
  }

  async _runCycle(persona, mind, msgs, timeContext) {
    const { cognitiveCycle, bots, defaultUserId } = this.components;
    if (!cognitiveCycle) return;
    this.stats.cyclesRun++;

    const decision = await cognitiveCycle.run({
      persona, mind,
      messages: msgs,
      timeContext,
      bot: bots?.[0],
      userId: msgs[0]?.userId,
      defaultUser: defaultUserId,
    });

    this.lastDecision.set(persona.personaId, {
      action: decision.action, thought: decision.thought,
      text: decision.acted?.text, at: Date.now(),
    });
    this.stats.thoughtsGenerated++;
    if (decision.acted?.text) this.stats.responsesGenerated++;
    if (decision.acted?.work) this.stats.worksDone++;
    if (decision.action === 'speak' && !msgs.length) this.stats.initiationsMade++;
    if (decision.acted?.text || decision.acted?.work) this.stats.memoriesEncoded++;

    // 立即冲刷输出
    if (this.components.bots?.length) {
      for (const bot of this.components.bots) {
        if (bot?.hasPendingOutput?.()) bot.flushOutput().catch(() => {});
      }
    }
  }

  async _triggerMicroSleep() {
    this.isSleeping = true;
    this.stats.microSleeps++;
    console.log(`[Heartbeat] Micro-sleep #${this.stats.microSleeps}...`);

    const { consolidationAgent, compressionAgent, forgettingAgent, associationAgent, metamemoryAgent, narrativeAgent, personaRegistry } = this.components;

    try {
      if (consolidationAgent) { const r = await consolidationAgent.consolidate(); console.log(`  Consolidation: ${r.consolidated}`); }
      if (compressionAgent) { const r = await compressionAgent.compress(); console.log(`  Compression: ${r.compressed}→${r.triples}`); }
      if (forgettingAgent) { const r = await forgettingAgent.forget(); this.stats.memoriesForgotten += r.expired + r.weakRemoved; console.log(`  Forgetting: ${r.expired} expired`); }
      if (associationAgent) { const r = await associationAgent.discover(); if (r.links) console.log(`  Association: ${r.links} links`); }
      if (metamemoryAgent) { await metamemoryAgent.checkConsistency(); }
      // 叙事：每个人格各自编织自己的故事线
      if (this.stats.microSleeps % 10 === 0 && narrativeAgent && personaRegistry) {
        for (const persona of personaRegistry.list()) {
          narrativeAgent.persona = persona;
          const r = await narrativeAgent.weaveNarrative();
          if (r?.title) console.log(`  Narrative(${persona.name}): ${r.title}`);
        }
      }
    } catch (e) {
      console.error('[Heartbeat] Micro-sleep error:', e.message);
    }

    await new Promise(r => setTimeout(r, config.heartbeat.microSleepDurationMs));
    this.isSleeping = false;
    console.log('[Heartbeat] Micro-sleep complete');
  }

  _buildTimeContext() {
    const nowDate = new Date();
    const loc = config.location;
    return {
      timestamp: nowDate.getTime(),
      year: nowDate.getFullYear(), month: nowDate.getMonth() + 1, day: nowDate.getDate(),
      hour: nowDate.getHours(), minute: nowDate.getMinutes(), second: nowDate.getSeconds(),
      weekday: ['日','一','二','三','四','五','六'][nowDate.getDay()],
      dayOfWeek: nowDate.getDay(),
      isNight: nowDate.getHours() >= 22 || nowDate.getHours() < 6,
      isWeekend: [0, 6].includes(nowDate.getDay()),
      season: this._getSeason(nowDate),
      location: { city: loc.city, region: loc.region, country: loc.country },
      tickCount: this.tickCount,
    };
  }

  getStats() {
    const lastThoughts = {};
    for (const [pid, d] of this.lastDecision) lastThoughts[pid] = d;
    return { ...this.stats, tickCount: this.tickCount, isSleeping: this.isSleeping, busy: [...this.busy], lastDecision: lastThoughts };
  }

  _getSeason(date) {
    const m = date.getMonth();
    if (m >= 2 && m <= 4) return 'spring';
    if (m >= 5 && m <= 7) return 'summer';
    if (m >= 8 && m <= 10) return 'autumn';
    return 'winter';
  }
}
