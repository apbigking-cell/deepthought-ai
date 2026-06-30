import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { config } from '../config.js';

// QQ官方机器人 WebSocket API
// 文档: https://q.qq.com
export class QQBot extends EventEmitter {
  constructor() {
    super();
    this.appId = config.qqBot.appId;
    this.clientSecret = config.qqBot.clientSecret;
    this.authBase = config.qqBot.authBase;
    this.apiBase = config.qqBot.apiBase;
    this.accessToken = null;
    this.tokenExpiresAt = 0;   // token过期时间戳
    this.gatewayUrl = null;    // 缓存网关地址，避免重复请求
    this.ws = null;
    this.seq = 0;
    this.sessionId = null;
    this.heartbeatTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.isConnecting = false; // 防止并发重连
    this.rateLimitCooldown = 0; // 频率限制冷却到何时

    // 消息缓冲区 — 入站消息攒1秒等心跳取走
    this.inboundBuffer = [];
    // 出站队列 — 心跳写入后在下一次发送
    this.outboundQueue = [];
  }

  // === 鉴权（带缓存，token有效期7200秒）===
  async authenticate() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return { access_token: this.accessToken }; // 缓存有效，不重复请求
    }
    const res = await fetch(`${this.authBase}/app/getAppAccessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
    });
    if (!res.ok) throw new Error(`QQ auth failed: ${await res.text()}`);
    const data = await res.json();
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in || 7200) * 1000;
    return data;
  }

  // === 获取网关（缓存，避免频率限制）===
  async getGateway() {
    if (this.gatewayUrl) return this.gatewayUrl;
    const res = await fetch(`${this.apiBase}/gateway`, {
      headers: { 'Authorization': `QQBot ${this.accessToken}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (err.code === 100017) {
        this.rateLimitCooldown = Date.now() + 60000;
        this.gatewayUrl = null; // 被限了，清缓存等冷却
      }
      throw new Error(`Gateway fetch failed: ${JSON.stringify(err)}`);
    }
    const data = await res.json();
    this.gatewayUrl = data.url;
    return data.url;
  }

  // === 连接 WebSocket ===
  async connect() {
    // 防止并发连接
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      // 频率限制冷却中
      if (Date.now() < this.rateLimitCooldown) {
        const wait = Math.ceil((this.rateLimitCooldown - Date.now()) / 1000);
        console.log(`[QQBot] Rate limit cooldown, waiting ${wait}s...`);
        this.isConnecting = false;
        return;
      }

      // 关闭旧连接
      if (this.ws) {
        try { this.ws.close(); } catch {}
        this.ws = null;
      }

      await this.authenticate();
      const wsUrl = await this.getGateway();

      this.ws = new WebSocket(wsUrl);
      this._setupHandlers();
    } catch (e) {
      this.isConnecting = false;
      throw e;
    }
  }

  _setupHandlers() {
    this.ws.on('open', () => {
      console.log('[QQBot] WebSocket connected');
      this.reconnectAttempts = 0;
      this.isConnecting = false;
    });

    this.ws.on('message', (data) => {
      try {
        const payload = JSON.parse(data.toString());
        this._handleMessage(payload);
      } catch (e) {
        console.error('[QQBot] Parse error:', e.message);
      }
    });

    this.ws.on('close', (code) => {
      console.log(`[QQBot] WebSocket closed: ${code}`);
      this._stopHeartbeat();
      this.isConnecting = false;

      // 服务器要求重连（code 4009/4903）—— 清除网关缓存
      if (code === 4009 || code === 4903) {
        this.gatewayUrl = null;
      }

      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        // 指数退避，起始2秒，最大60秒
        const delay = Math.min(2000 * 2 ** this.reconnectAttempts, 60000);
        console.log(`[QQBot] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})...`);
        setTimeout(() => {
          this.reconnectAttempts++;
          this.connect().catch(e => console.error('[QQBot] Reconnect failed:', e.message));
        }, delay);
      } else {
        console.error('[QQBot] Max reconnect attempts reached. Please restart.');
      }
    });

    this.ws.on('error', (err) => {
      console.error('[QQBot] WebSocket error:', err.message);
      this.isConnecting = false;
    });

  }

  _handleMessage(payload) {
    const { op, d, s, t } = payload;

    // 更新seq
    if (s) this.seq = s;

    switch (op) {
      case 10: // Hello
        console.log('[QQBot] Received Hello, starting heartbeat');
        this.sessionId = d?.session_id;
        this._startHeartbeat(d?.heartbeat_interval || 41250);
        // 发送鉴权
        this._sendIdentify();
        break;

      case 11: // Heartbeat ACK
        break;

      case 0: // Dispatch — 收到消息
        if (t === 'C2C_MESSAGE_CREATE' || t === 'AT_MESSAGE_CREATE') {
          this._handleInboundMessage(d);
        }
        break;

      case 7: // Reconnect
        console.log('[QQBot] Server requested reconnect');
        this.ws?.close();
        this.connect().catch(e => console.error(e));
        break;
    }
  }

  _sendIdentify() {
    this._send({
      op: 2,
      d: {
        token: `QQBot ${this.accessToken}`,
        intents: 1 << 25, // C2C消息
        shard: [0, 1],
        properties: {},
      },
    });
  }

  _send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  _startHeartbeat(interval) {
    this._stopHeartbeat();
    // QQ要求每 interval 毫秒发一次心跳
    this.heartbeatTimer = setInterval(() => {
      this._send({ op: 1, d: this.seq });
    }, interval);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // === 入站消息处理 ===
  _handleInboundMessage(d) {
    const msg = {
      id: d.id,
      userId: d.author?.id,
      username: d.author?.username,
      content: d.content || '',
      timestamp: Date.now(),
      type: 'social_message',
    };

    console.log('');
    console.log('╔═══════════════════ QQ消息(入) ═══════════════════╗');
    console.log(`║  来自: ${msg.username} (${msg.userId})`);
    console.log(`║  时间: ${new Date(msg.timestamp).toLocaleTimeString('zh-CN')}`);
    console.log(`║  内容: ${msg.content}`);
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
    this.inboundBuffer.push(msg);
  }

  // === 发送消息 ===
  async sendMessage(userId, content, replyToMsgId = null) {
    const body = { content, msg_type: 0 };

    // 被动回复：使用收到的消息ID（3分钟有效期）
    if (replyToMsgId) {
      body.msg_id = replyToMsgId;
      const seqKey = `${replyToMsgId}_${userId}`;
      const seq = (this._msgSeqMap?.get(seqKey) || 0) + 1;
      if (!this._msgSeqMap) this._msgSeqMap = new Map();
      this._msgSeqMap.set(seqKey, seq);
      body.msg_seq = seq;
    }

    const res = await fetch(`${this.apiBase}/v2/users/${userId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `QQBot ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.log('');
      console.log('╔═══════════════ QQ消息(出) 失败 ═══════════════╗');
      console.log(`║  目标: ${userId}`);
      console.log(`║  错误: ${errText}`);
      console.log('╚══════════════════════════════════════════════╝');
      console.log('');
      return false;
    }

    const data = await res.json();
    console.log('');
    console.log('╔═══════════════════ QQ消息(出) ═══════════════════╗');
    console.log(`║  发送给: ${userId}`);
    console.log(`║  时间: ${new Date().toLocaleTimeString('zh-CN')}`);
    console.log(`║  内容: ${content}`);
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
    return data.id || true;
  }

  // === 心跳引擎调用的接口 ===

  // 收集上一秒缓冲的入站消息
  collectInbound() {
    const batch = [...this.inboundBuffer];
    this.inboundBuffer = [];
    return batch;
  }

  // 将输出加入发送队列
  enqueueOutput(userId, content, replyToMsgId = null) {
    this.outboundQueue.push({ userId, content, replyToMsgId });
  }

  // 发送所有排队的消息
  async flushOutput() {
    const batch = [...this.outboundQueue];
    this.outboundQueue = [];
    for (const item of batch) {
      await this.sendMessage(item.userId, item.content, item.replyToMsgId);
    }
    return batch.length;
  }

  // 缓冲中有等待的消息吗？
  hasPendingInput() {
    return this.inboundBuffer.length > 0;
  }

  hasPendingOutput() {
    return this.outboundQueue.length > 0;
  }

  // === 断开 ===
  async disconnect() {
    this.isConnecting = false;
    this.reconnectAttempts = this.maxReconnectAttempts; // 阻止自动重连
    this._stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
