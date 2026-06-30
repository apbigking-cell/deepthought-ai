// L0 感觉记忆 — 原始输入缓冲区，~2秒保留
export class SensoryBuffer {
  constructor(ttlMs = 2000) {
    this.ttlMs = ttlMs;
    this.buffer = []; // [{ data, channel, timestamp }]
  }

  // 写入感觉数据
  write(data, channel = 'general') {
    const entry = { data, channel, timestamp: Date.now() };
    this.buffer.push(entry);
    this._gc();
  }

  // 读取指定时间窗口内的感觉数据
  read(channel = null, windowMs = null) {
    const cutoff = Date.now() - (windowMs || this.ttlMs);
    return this.buffer.filter(e =>
      e.timestamp > cutoff &&
      (!channel || e.channel === channel)
    ).map(e => e.data);
  }

  // 读取所有通道的最新数据
  readAll(windowMs = null) {
    const cutoff = Date.now() - (windowMs || this.ttlMs);
    return this.buffer.filter(e => e.timestamp > cutoff);
  }

  _gc() {
    const cutoff = Date.now() - this.ttlMs;
    this.buffer = this.buffer.filter(e => e.timestamp > cutoff);
  }

  clear() {
    this.buffer = [];
  }

  get size() {
    this._gc();
    return this.buffer.length;
  }
}
