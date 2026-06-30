import { getDb, saveToDisk } from '../db/sqlite.js';

// WebBot — 把 WebUI 在线聊天接入与 QQ/微信一致的 Bot 接口，
// 从而 Web 消息也走完整认知管线（心智→感知→思考→决策→记忆编码）。
// constructor.name === 'WebBot' → 平台标识 'web'
export class WebBot {
  constructor() {
    this.inboundBuffer = [];
    this.outboundQueue = [];
    this._sink = null; // (userId, text) => void 投递到 WebSocket
    this.db = getDb();
    this.connected = true;
  }

  setSink(fn) { this._sink = fn; }

  // WebUI 收到用户消息 → 入站
  receiveFromWeb(userId, content, username = 'Web用户') {
    const id = 'web_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const msg = { id, userId, username, content, type: 'social_message', platform: 'web', timestamp: Date.now() };
    this.inboundBuffer.push(msg);
    this._log('in', userId, content);
    return id;
  }

  collectInbound() {
    const batch = [...this.inboundBuffer];
    this.inboundBuffer = [];
    return batch;
  }

  enqueueOutput(userId, content, replyToMsgId = null) {
    this.outboundQueue.push({ userId, content, replyToMsgId });
  }

  hasPendingOutput() { return this.outboundQueue.length > 0; }
  hasPendingInbound() { return this.inboundBuffer.length > 0; }

  async flushOutput() {
    const batch = [...this.outboundQueue];
    this.outboundQueue = [];
    for (const item of batch) {
      this._log('out', item.userId, item.content);
      if (this._sink) {
        try { this._sink(item.userId, item.content); } catch (e) { console.error('[WebBot] sink error:', e.message); }
      }
    }
  }

  _log(direction, userId, content) {
    try {
      this.db.prepare('INSERT INTO message_log (id, direction, user_id, content, timestamp) VALUES (?,?,?,?,?)')
        .run('web_' + Date.now() + '_' + direction + Math.random().toString(36).slice(2, 5), direction, userId, content, Date.now());
      saveToDisk();
    } catch {}
  }

  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
}
