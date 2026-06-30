// 记忆层级统一导出
export { SensoryBuffer } from './sensory.js';
export { WorkingMemory } from './working.js';
export { EpisodicMemory } from './episodic.js';
export { SemanticMemory } from './semantic.js';
export { ProceduralMemory } from './procedural.js';
export { MetaMemory } from './meta.js';

// 记忆存储聚合 — 所有层次在一个对象中
export class MemoryStore {
  constructor() {
    this.sensory = null;     // L0 — 外部注入
    this.working = null;     // L1 — 外部注入
    this.episodic = null;    // L2 — 外部注入
    this.semantic = null;    // L3 — 外部注入
    this.procedural = null;  // L4 — 外部注入
    this.meta = null;        // L5 — 外部注入
  }
}
