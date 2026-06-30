import { EventEmitter } from 'events';
import { config } from '../config.js';

// 微信 iLink Bot — 官方个人号机器人
// 通过 iLink API 长轮询收消息，HTTP 发消息
// 无需 OpenClaw 框架，直接裸调

const BASE = 'https://ilinkai.weixin.qq.com';

export class WeixinBot extends EventEmitter {
  constructor() {
    super();
    this.botToken = config.weixinBot?.botToken || null;
    this.isRunning = false;
    this.pollTimer = null;
    this.getUpdatesBuf = '';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.seenMsgIds = new Set(); // 本次会话内去重

    // 消息缓冲区（和QQ Bot一样的接口）
    this.inboundBuffer = [];
    this.outboundQueue = [];
  }

  // 生成随机 X-WECHAT-UIN
  _randomUin() {
    const uin = Math.floor(Math.random() * 0xFFFFFFFF);
    return Buffer.from(String(uin)).toString('base64');
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': this._randomUin(),
      'Authorization': `Bearer ${this.botToken}`,
    };
  }

  // === 登录流程 ===

  // Step 1: 获取二维码（未登录时调用）
  async getLoginQrcode() {
    const res = await fetch(`${BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      headers: { 'iLink-App-ClientVersion': '1' },
    });
    if (!res.ok) throw new Error(`获取二维码失败: ${await res.text()}`);
    const data = await res.json();
    // qrcode_img_content 是微信官方的扫码短链接（如 https://liteapp.weixin.qq.com/q/xxx）
    return {
      qrcode: data.qrcode,
      qrcodeUrl: data.qrcode_img_content || data.qrcode,
      raw: data,
    };
  }

  // Step 2: 轮询扫码结果
  async waitForScan(qrcode, timeoutMs = 180000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await fetch(`${BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
        headers: { 'iLink-App-ClientVersion': '1' },
      });
      const data = await res.json();
      if (data.status === 'confirmed') {
        this.botToken = data.bot_token;
        return { status: 'confirmed', token: data.bot_token, data };
      }
      if (data.status === 'expired') {
        return { status: 'expired' };
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    return { status: 'timeout' };
  }

  // === 连接 ===

  async connect() {
    if (!this.botToken) {
      throw new Error('微信 Bot Token 未设置。需要先扫码登录获取 token。');
    }

    // 验证 token 有效性
    try {
      const res = await fetch(`${BASE}/ilink/bot/getupdates`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({
          get_updates_buf: '',
          base_info: { channel_version: '1.0.2' },
        }),
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error('Token 已过期，需要重新扫码');
      }
    } catch (e) {
      throw new Error(`微信连接验证失败: ${e.message}`);
    }

    this.isRunning = true;
    this.reconnectAttempts = 0;
    console.log('[WeixinBot] Connected');
    this._startPolling();
  }

  // === 长轮询 ===

  _startPolling() {
    if (!this.isRunning) return;
    this._poll().catch(e => {
      console.error('[WeixinBot] Poll error:', e.message);
      this._handleReconnect();
    });
  }

  async _poll() {
    while (this.isRunning) {
      try {
        const res = await fetch(`${BASE}/ilink/bot/getupdates`, {
          method: 'POST',
          headers: this._headers(),
          body: JSON.stringify({
            get_updates_buf: this.getUpdatesBuf,
            base_info: { channel_version: '1.0.2' },
          }),
        });

        if (res.status === 401 || res.status === 403) {
          console.error('[WeixinBot] Token expired');
          this.isRunning = false;
          this.emit('token_expired');
          return;
        }

        const data = await res.json();

        if (data.ret === -14 || data.errcode === -14) {
          console.error('[WeixinBot] Session expired, need re-login');
          this.isRunning = false;
          this.emit('session_expired');
          return;
        }

        // 始终更新游标（空也更新，避免重复拉取）
        this.getUpdatesBuf = data.get_updates_buf || this.getUpdatesBuf;

        // 处理消息（session内去重）
        if (data.msgs?.length > 0) {
          for (const msg of data.msgs) {
            const mid = String(msg.message_id || '');
            if (mid && this.seenMsgIds.has(mid)) continue;
            if (mid) this.seenMsgIds.add(mid);
            this._handleMessage(msg);
          }
        }
      } catch (e) {
        if (this.isRunning) {
          console.error('[WeixinBot] Poll exception:', e.message);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }
  }

  _handleReconnect() {
    if (!this.isRunning) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WeixinBot] Max reconnect attempts reached');
      this.isRunning = false;
      return;
    }
    const delay = Math.min(3000 * 2 ** this.reconnectAttempts, 60000);
    this.reconnectAttempts++;
    console.log(`[WeixinBot] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    setTimeout(() => this._startPolling(), delay);
  }

  // === 消息处理 ===

  _handleMessage(msg) {
    const textItem = msg.item_list?.find(i => i.type === 1)?.text_item;
    if (!textItem?.text) return;

    // 优先使用WeChat原生的message_id（可被去重），只在确实没有时才生成
    const rawId = msg.message_id ? String(msg.message_id) : '';
    const inbound = {
      id: rawId || `wx_${Date.now()}_${textItem.text?.slice(0, 10).replace(/\s/g,'')}`,
      userId: msg.from_user_id,
      username: '微信朋友',
      content: textItem.text,
      timestamp: Date.now(),
      type: 'social_message',
      // 微信特有：回传 context_token 用于回复
      contextToken: msg.context_token,
    };

    console.log('');
    console.log('╔══════════════════ 微信消息(入) ══════════════════╗');
    console.log(`║  来自: ${inbound.username}`);
    console.log(`║  时间: ${new Date(inbound.timestamp).toLocaleTimeString('zh-CN')}`);
    console.log(`║  内容: ${inbound.content}`);
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');

    this.inboundBuffer.push(inbound);
  }

  // === 发送消息 ===

  async sendMessage(userId, content, contextToken = null) {
    const clientId = `meme-${Math.random().toString(36).slice(2, 10)}`;

    const body = {
      msg: {
        to_user_id: userId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken || '',
        item_list: [
          { type: 1, text_item: { text: content } },
        ],
      },
      base_info: { channel_version: '1.0.2' },
    };

    const res = await fetch(`${BASE}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.log('');
      console.log('╔══════════════ 微信消息(出) 失败 ══════════════════╗');
      console.log(`║  目标: ${userId}`);
      console.log(`║  错误: ${errText}`);
      console.log('╚══════════════════════════════════════════════════╝');
      console.log('');
      return false;
    }

    const data = await res.json();
    console.log('');
    console.log('╔══════════════════ 微信消息(出) ═══════════════════╗');
    console.log(`║  发送给: ${userId}`);
    console.log(`║  时间: ${new Date().toLocaleTimeString('zh-CN')}`);
    console.log(`║  内容: ${content}`);
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
    return data.ret === 0 || true;
  }

  // === 心跳引擎调用的接口（与QQ Bot一致）===

  collectInbound() {
    const batch = [...this.inboundBuffer];
    this.inboundBuffer = [];
    return batch;
  }

  enqueueOutput(userId, content, contextToken = null) {
    this.outboundQueue.push({ userId, content, contextToken });
  }

  async flushOutput() {
    const batch = [...this.outboundQueue];
    this.outboundQueue = [];
    for (const item of batch) {
      await this.sendMessage(item.userId, item.content, item.contextToken);
    }
    return batch.length;
  }

  hasPendingInput() {
    return this.inboundBuffer.length > 0;
  }

  hasPendingOutput() {
    return this.outboundQueue.length > 0;
  }

  // === 断开 ===
  async disconnect() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[WeixinBot] Disconnected');
  }
}

// === 辅助：交互式扫码获取 token ===
export async function weixinLoginInteractive() {
  const bot = new WeixinBot();

  console.log('[WeixinBot] 正在获取登录二维码...');
  let qrcode, qrcodeUrl;
  try {
    const result = await bot.getLoginQrcode();
    qrcode = result.qrcode;
    qrcodeUrl = result.qrcodeUrl;
  } catch (e) {
    console.error('[WeixinBot] 获取二维码失败:', e.message);
    return { success: false, error: e.message };
  }

  // 终端打印二维码
  console.log('');
  console.log('┌──────────────────────────────────────────┐');
  console.log('│       请用微信扫描二维码登录               │');
  console.log('└──────────────────────────────────────────┘');
  console.log('');

  try {
    const qrcodeLib = await import('qrcode-terminal');
    qrcodeLib.default.generate(qrcodeUrl, { small: true }, (qr) => {
      console.log(qr);
    });
  } catch {
    // 降级：打印链接
    console.log(`[终端不支持二维码，请在浏览器打开]: ${qrcodeUrl}`);
  }

  console.log('');
  console.log(`[或打开链接扫码]: ${qrcodeUrl}`);
  console.log('');

  // 等待扫码
  console.log('[WeixinBot] 等待扫码（3分钟超时）...');
  const scanResult = await bot.waitForScan(qrcode, 180000);

  if (scanResult.status === 'confirmed') {
    console.log('[WeixinBot] 扫码成功！');
    console.log(`[WeixinBot] Token: ${scanResult.token}`);
    return { success: true, token: scanResult.token };
  } else if (scanResult.status === 'expired') {
    console.log('[WeixinBot] 二维码已过期，请重新运行 /weixin');
    return { success: false, error: 'qrcode_expired' };
  } else {
    console.log('[WeixinBot] 等待超时');
    return { success: false, error: 'timeout' };
  }
}
