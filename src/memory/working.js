import { config } from '../config.js';

// L1 工作记忆 — 前额叶模拟，7±2 chunks，~30秒
export class WorkingMemory {
  constructor() {
    this.capacity = config.memory.workingMemoryCapacity;
    this.ttlMs = config.memory.workingMemoryTtlMs;
    this.chunks = []; // [{ id, content, type, created, lastAccessed, embedding }]
  }

  // 放入一个chunk
  put(content, type = 'general') {
    const chunk = {
      id: `wm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content,
      type,
      created: Date.now(),
      lastAccessed: Date.now(),
      embedding: null,
    };

    this.chunks.push(chunk);

    // 容量管理：FIFO + 显著性
    while (this.chunks.length > this.capacity) {
      this._evict();
    }

    return chunk.id;
  }

  // 访问chunk（刷新lastAccessed）
  access(id) {
    const chunk = this.chunks.find(c => c.id === id);
    if (chunk) {
      chunk.lastAccessed = Date.now();
      return chunk;
    }
    return null;
  }

  // 获取所有活跃chunk
  getActive() {
    this._gc();
    return [...this.chunks];
  }

  // 按类型获取
  getByType(type) {
    this._gc();
    return this.chunks.filter(c => c.type === type);
  }

  // 获取最近的chunk
  getRecent(n = 3) {
    this._gc();
    return [...this.chunks]
      .sort((a, b) => b.lastAccessed - a.lastAccessed)
      .slice(0, n);
  }

  // 清除指定chunk
  remove(id) {
    this.chunks = this.chunks.filter(c => c.id !== id);
  }

  // 清除所有
  clear() {
    this.chunks = [];
  }

  // 将工作记忆中的内容提升为长期记忆素材
  promoteToEpisodic() {
    this._gc();
    // 返回最有价值的内容（最常访问的、最近的）
    const sorted = [...this.chunks].sort((a, b) => b.lastAccessed - a.lastAccessed);
    return sorted.slice(0, 3).map(c => ({
      content: c.content,
      type: c.type,
      lastAccessed: c.lastAccessed,
    }));
  }

  _evict() {
    // 淘汰最旧的chunk
    this.chunks.sort((a, b) => a.lastAccessed - b.lastAccessed);
    this.chunks.shift();
  }

  _gc() {
    const cutoff = Date.now() - this.ttlMs;
    this.chunks = this.chunks.filter(c => c.lastAccessed > cutoff);
  }

  get size() {
    this._gc();
    return this.chunks.length;
  }
}
