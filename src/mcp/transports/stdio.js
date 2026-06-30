import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// MCP JSON-RPC over stdio transport
export class StdioTransport extends EventEmitter {
  constructor(command, args = []) {
    super();
    this.command = command;
    this.args = args;
    this.process = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      });

      this.process.stdout.on('data', (data) => {
        this.buffer += data.toString();
        this._parseMessages();
      });

      this.process.stderr.on('data', (data) => {
        console.error(`[MCP:${this.command}] ${data.toString().trim()}`);
      });

      this.process.on('error', (err) => {
        console.error(`[MCP:${this.command}] Process error:`, err.message);
        this.emit('error', err);
      });

      this.process.on('close', (code) => {
        console.log(`[MCP:${this.command}] Process exited (${code})`);
        this.emit('disconnected', code);
      });

      // MCP初始化握手
      this._sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'brain-agent', version: '0.1.0' },
      }).then(() => {
        // 发送 initialized 通知
        this._sendNotification('notifications/initialized', {});
        resolve();
      }).catch(reject);
    });
  }

  async _sendRequest(method, params = {}) {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    this.process.stdin.write(msg + '\n');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timeout });
    });
  }

  _sendNotification(method, params = {}) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.process.stdin.write(msg + '\n');
  }

  _parseMessages() {
    while (this.buffer.includes('\n')) {
      const idx = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, timeout } = this.pending.get(msg.id);
          clearTimeout(timeout);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
          else resolve(msg.result);
        } else if (msg.method) {
          this.emit('notification', msg);
        }
      } catch (e) {
        // 非JSON行，忽略
      }
    }
  }

  async listTools() {
    const result = await this._sendRequest('tools/list', {});
    return result?.tools || [];
  }

  async callTool(name, args) {
    return await this._sendRequest('tools/call', { name, arguments: args });
  }

  async disconnect() {
    for (const [id, { timeout }] of this.pending) {
      clearTimeout(timeout);
      this.pending.delete(id);
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  get isConnected() {
    return this.process && !this.process.killed;
  }
}
