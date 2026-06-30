import http from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { getDb, saveToDisk } from '../db/sqlite.js';
import { llm } from '../llm/deepseek.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class WebUIServer {
  constructor(components) {
    this.components = components;
    this.server = null;
    this.wss = null;
    this.port = parseInt(process.env.WEBUI_PORT || process.env.PORT || '3000');
    this.statusSubs = new Set();
    this.sockets = new Set();
    this._statusTimer = null;
    this._sinkBound = false;
  }

  start() {
    if (this.server) return false;
    this._tryListen(this.port);
    return true;
  }

  _tryListen(port) {
    const srv = http.createServer((req, res) => this._handle(req, res));
    srv.once('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.log(`[WebUI] Port ${port} busy, trying ${port + 1}...`);
        this._tryListen(port + 1);
      }
    });
    srv.listen(port, () => {
      this.server = srv;
      this.port = port;
      // WebSocket on same server
      this.wss = new WebSocketServer({ server: srv });
      this.wss.on('connection', (ws) => this._onWsConnect(ws));
      // Status broadcast every 1s
      this._statusTimer = setInterval(() => this._broadcastStatus(), 1000);
      this._bindChatSink();
      console.log(`[WebUI] http://localhost:${port}  (WS ready)`);
    });
  }

  async stop() {
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null; }
    if (this.wss) { this.wss.close(); this.wss = null; }
    if (!this.server) return;
    return new Promise(r => this.server.close(() => { this.server = null; r(); }));
  }

  // 把 WebBot 的输出投递回所有 WebSocket 客户端（认知管线产生的回复）
  _bindChatSink() {
    const webBot = this.components.webBot;
    if (!webBot || this._sinkBound) return;
    this._sinkBound = true;
    webBot.setSink((userId, text) => {
      const persona = this.components.personaRouter?.resolvePersona('web', userId);
      const pid = persona?.personaId;
      let thought = null;
      try { thought = pid ? this.components.mindRegistry?.get(pid, persona.autonomyMode).snapshot().currentThought : null; } catch {}
      const payload = JSON.stringify({ type: 'chat_reply', text, persona: persona?.name || '', personaId: pid, thought });
      for (const ws of this.sockets) if (ws.readyState === 1) ws.send(payload);
      // push to HTTP poll buffer
      this._chatReplies = this._chatReplies || [];
      this._chatReplies.push({ text, persona: persona?.name || '', personaId: pid, thought });
    });
  }

  // === WebSocket ===
  _onWsConnect(ws) {
    this.sockets.add(ws);
    this._bindChatSink();
    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        await this._handleWs(ws, msg);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', error: e.message }));
      }
    });
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('error', () => {});
  }

  async _handleWs(ws, msg) {
    switch (msg.type) {
      case 'subscribe_status':
        this.statusSubs.add(ws);
        ws.once('close', () => this.statusSubs.delete(ws));
        ws.send(JSON.stringify({ type: 'status', data: this._getStatus() }));
        break;

      case 'unsubscribe_status':
        this.statusSubs.delete(ws);
        break;

      case 'set_persona': {
        // 选择和哪个人格对话（绑定 web/web_user → personaId）
        const pid = msg.personaId;
        if (pid && this.components.personaRouter) {
          this.components.personaRouter.assignPersona('web', 'web_user', pid);
          const p = this.components.personaRegistry?.getPersona(pid);
          ws.send(JSON.stringify({ type: 'persona_set', personaId: pid, name: p?.name || pid }));
        }
        break;
      }

      case 'chat': {
        const text = (msg.message || '').trim();
        if (!text) { ws.send(JSON.stringify({ type: 'chat_error', error: 'empty' })); break; }

        const { webBot, personaRouter, personaRegistry } = this.components;
        if (!webBot) { ws.send(JSON.stringify({ type: 'chat_error', error: 'webbot 未就绪' })); break; }

        // 切换对话人格（如带了 persona 字段）
        if (msg.personaId && personaRouter) personaRouter.assignPersona('web', 'web_user', msg.personaId);

        // 让对方知道是谁在回复
        const persona = personaRouter?.resolvePersona('web', 'web_user') || personaRegistry?.getDefault();
        ws.send(JSON.stringify({ type: 'chat_thinking', persona: persona?.name || '', personaId: persona?.personaId }));

        // 投入认知管线：下一次心跳会被路由到对应人格→感知→思考→决策→回复
        webBot.receiveFromWeb('web_user', text, 'Web用户');
        break;
      }

      case 'chat_stop':
        break;
    }
  }

  _broadcastStatus() {
    if (this.statusSubs.size === 0) return;
    const data = this._getStatus();
    const payload = JSON.stringify({ type: 'status', data });
    for (const ws of this.statusSubs) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  _getStatus() {
    const { workingMemory, orchestrator, personaRegistry, memoryStore, mindRegistry, goalStore, approvalQueue } = this.components;
    const stats = orchestrator?.getStats() || {};
    const defPersona = personaRegistry?.getDefault();
    const defId = defPersona?.personaId || personaRegistry?.defaultId;
    const mind = mindRegistry?.get(defId, defPersona?.autonomyMode);
    const snap = mind?.snapshot() || {};
    const wm = workingMemory?.getActive() || [];
    let memCount = 0;
    try { memCount = getDb().prepare('SELECT COUNT(*) as cnt FROM episodic_memories WHERE expires_at > ?').get(Date.now())?.cnt || 0; } catch {}

    // 每人格的心智快照 + 最近决策
    const personas = (personaRegistry?.list() || []).map(p => {
      const m = mindRegistry?.get(p.personaId, p.autonomyMode).snapshot() || {};
      const dec = stats.lastDecision?.[p.personaId];
      return {
        id: p.personaId, name: p.name, autonomy: p.autonomyMode,
        mood: m.emotionLabel, valence: m.valence, arousal: m.arousal,
        energy: m.energy, socialDrive: m.socialDrive,
        currentThought: m.currentThought,
        lastAction: dec?.action, lastText: dec?.text,
        goals: goalStore?.active(p.personaId).length || 0,
        busy: (stats.busy || []).includes(p.personaId),
      };
    });

    return {
      tick: stats.ticksTotal || 0,
      mood: snap.emotionLabel || 'neutral',
      valence: snap.valence || 0, arousal: snap.arousal || 0.3, dominance: snap.dominance || 0.5,
      energy: snap.energy || 0, socialDrive: snap.socialDrive || 0,
      currentThought: snap.currentThought || null,
      wmSize: wm.length,
      memCount,
      persona: defPersona?.name || '林夏',
      personas,
      approvals: approvalQueue?.list() || [],
      isSleeping: orchestrator?.isSleeping || false,
      isProcessing: (stats.busy || []).length > 0,
      messagesProcessed: stats.messagesProcessed || 0,
      cyclesRun: stats.cyclesRun || 0,
      thoughtsGenerated: stats.thoughtsGenerated || 0,
      worksDone: stats.worksDone || 0,
      responsesGenerated: stats.responsesGenerated || 0,
      memoriesEncoded: stats.memoriesEncoded || 0,
      initiationsMade: stats.initiationsMade || 0,
      microSleeps: stats.microSleeps || 0,
      memoriesForgotten: stats.memoriesForgotten || 0,
      qqConnected: this._isBotConnected('qq'),
      wxConnected: this._isBotConnected('weixin'),
    };
  }

  // === HTTP ===
  async _handle(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${this.port}`);
    if (url.pathname === '/' || url.pathname === '/index.html') return this._serveHtml(res);
    if (url.pathname.startsWith('/api/')) return await this._api(url.pathname, url.searchParams, req, res);
    res.writeHead(404); res.end('Not Found');
  }

  _serveHtml(res) {
    const html = readFileSync(resolve(__dirname, 'dashboard.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  async _api(path, params, req, res) {
    const body = req.method === 'POST' ? await this._body(req) : {};
    let result;

    switch (path) {
      case '/api/config': {
        const db = getDb();
        const dbConfig = {};
        const rows = db.prepare('SELECT key, value FROM system_config').all();
        for (const r of rows) dbConfig[r.key] = r.value;
        result = {
          llm: { model: config.llm.model, maxTokens: config.llm.maxTokens, temperature: config.llm.temperature },
          location: { city: dbConfig.LOCATION_CITY || config.location.city, region: dbConfig.LOCATION_REGION || config.location.region, country: dbConfig.LOCATION_COUNTRY || config.location.country, timezone: dbConfig.LOCATION_TIMEZONE || config.location.timezone },
          heartbeat: { intervalMs: parseInt(dbConfig.HEARTBEAT_INTERVAL_MS || config.heartbeat.intervalMs), microSleepIntervalTicks: parseInt(dbConfig.MICRO_SLEEP_INTERVAL_TICKS || config.heartbeat.microSleepIntervalTicks) },
          qq: { appId: !!config.qqBot.appId, clientSecret: !!config.qqBot.clientSecret, appIdMasked: config.qqBot.appId ? config.qqBot.appId.slice(0,4)+'****' : '', connected: this._isBotConnected('qq') },
          weixin: { hasToken: !!config.weixinBot.botToken, connected: this._isBotConnected('weixin') },
        };
        break;
      }
      case '/api/config/save': {
        const db = getDb(); const now = Date.now();
        for (const [k, v] of Object.entries(body)) db.prepare('INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?,?,?)').run(k, String(v), now);
        saveToDisk(); result = { ok: true }; break;
      }
      case '/api/status':
        result = this._getStatus(); break;
      case '/api/chat/send': {
        const text = (body.message || '').trim();
        if (!text) { result = { error: 'empty' }; break; }
        const { webBot, personaRouter, personaRegistry } = this.components;
        if (!webBot) { result = { error: 'webbot not ready' }; break; }
        if (body.personaId) personaRouter?.assignPersona('web', 'web_user', body.personaId);
        const persona = personaRouter?.resolvePersona('web', 'web_user') || personaRegistry?.getDefault();
        // queue replies for HTTP polling
        this._chatReplies = this._chatReplies || [];
        this._chatMsgId = this._chatMsgId || 0;
        this._chatMsgId++;
        const msgId = this._chatMsgId;
        // save resolve for later
        this._chatReplyResolvers = this._chatReplyResolvers || new Map();
        webBot.receiveFromWeb('web_user', text, 'Web用户');
        result = { ok: true, queued: true, msgId, persona: persona?.name || '', personaId: persona?.personaId };
        break;
      }
      case '/api/chat/poll': {
        const pending = this._chatReplies?.shift();
        if (pending) {
          result = { ok: true, reply: pending.text, persona: pending.persona, personaId: pending.personaId, thought: pending.thought };
        } else {
          result = { ok: true, reply: null };
        }
        break;
      }
      case '/api/personas':
        result = this.components.personaRegistry?.list().map(p => p.getSummary()) || []; break;
      case '/api/persona/switch':
        this.components.personaRegistry?.activate(body.personaId); result = { ok: true }; break;
      case '/api/persona/register':
        this.components.personaRegistry?.registerSeed(body.seedFile); result = { ok: true }; break;
      case '/api/tools':
        result = this.components.toolRegistry?.list() || []; break;
      case '/api/tool/add':
        this.components.toolRegistry?.registerSkill(body.name, body.desc || body.name, body.code); result = { ok: true }; break;
      case '/api/tool/remove':
        this.components.toolRegistry?.unregisterTool(body.name); result = { ok: true }; break;
      case '/api/mcp':
        result = this.components.mcpManager?.getStatus() || []; break;
      case '/api/mcp/add': {
        const mcp = this.components.mcpManager;
        if (mcp) await mcp.addAndConnect(body.name, body.command, (body.args || '').split(/\s+/));
        result = { ok: true }; break;
      }
      case '/api/mcp/remove':
        await this.components.mcpManager?.removeServer(body.name); result = { ok: true }; break;
      case '/api/chat/history': {
        const db = getDb();
        const limit = parseInt(params.get('limit') || '50');
        result = db.prepare(
          'SELECT direction, content, timestamp FROM message_log WHERE user_id = ? ORDER BY timestamp ASC LIMIT ?'
        ).all('web_user', limit);
        break;
      }
      case '/api/thoughts': {
        const pid = params.get('persona') || this.components.personaRegistry?.defaultId;
        const limit = parseInt(params.get('limit') || '50');
        const db = getDb();
        result = db.prepare(
          'SELECT tick, kind, content, action, valence, created_at FROM thought_stream WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?'
        ).all(pid, limit);
        break;
      }
      case '/api/goals': {
        const pid = params.get('persona') || this.components.personaRegistry?.defaultId;
        result = this.components.goalStore?.list(pid) || [];
        break;
      }
      case '/api/goals/control': {
        const gs = this.components.goalStore;
        if (gs && body.id) {
          if (body.op === 'pause') gs.pause(body.id);
          else if (body.op === 'resume') gs.resume(body.id);
          else if (body.op === 'abandon') gs.abandon(body.id);
          else if (body.op === 'complete') gs.complete(body.id);
        }
        result = { ok: true };
        break;
      }
      case '/api/goals/create': {
        const gs = this.components.goalStore;
        const pid = body.persona || this.components.personaRegistry?.defaultId;
        const id = gs?.create(pid, { title: body.title, description: body.description || '', kind: body.kind || 'goal', priority: body.priority ?? 0.5 });
        result = { ok: true, id };
        break;
      }
      case '/api/approvals':
        result = this.components.approvalQueue?.list() || []; break;
      case '/api/approvals/approve':
        result = await (this.components.approvalQueue?.approve(body.id) || { ok: false }); break;
      case '/api/approvals/reject':
        result = this.components.approvalQueue?.reject(body.id) || { ok: false }; break;
      case '/api/memory/working':
        result = this.components.workingMemory?.getActive().map(c => ({ type: c.type, content: c.content?.slice(0,200), created: c.created })) || []; break;
      case '/api/memory/episodic': {
        const page = parseInt(params.get('page') || '1'), limit = 20;
        const db = getDb();
        result = { rows: db.prepare('SELECT id,summary,content,significance,valence,created_at,tags FROM episodic_memories WHERE expires_at>? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(Date.now(),limit,(page-1)*limit), total: db.prepare('SELECT COUNT(*) as cnt FROM episodic_memories WHERE expires_at>?').get(Date.now())?.cnt||0, page, limit };
        break;
      }
      default: res.writeHead(404); res.end('{}'); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  }

  _body(req) {
    return new Promise(resolve => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{resolve(JSON.parse(d))}catch{resolve({})} }); });
  }

  _isBotConnected(type) {
    for (const bot of (this.components.bots || [])) {
      const n = bot?.constructor?.name || '';
      if (type === 'qq' && n === 'QQBot') return bot?.ws?.readyState === 1;
      if (type === 'weixin' && n === 'WeixinBot') return bot?.isRunning === true;
    }
    return false;
  }
}
