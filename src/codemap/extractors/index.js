import path from 'node:path';
import { extractJs } from './js.js';

// 语言 → extractor 注册表（多语言扩展位）。
// extractor 签名：(code: string, filePath: string) => ExtractResult
const REGISTRY = new Map();

export function registerExtractor(extensions, fn) {
  for (const ext of extensions) REGISTRY.set(ext.toLowerCase(), fn);
}

// 内置：JS/TS 系
registerExtractor(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'], extractJs);

export function getExtractor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return REGISTRY.get(ext) || null;
}

export function isSupported(filePath) {
  return REGISTRY.has(path.extname(filePath).toLowerCase());
}

// 统一入口：返回 extractor 结果，或 null（不支持的语言）
export function extract(code, filePath) {
  const fn = getExtractor(filePath);
  if (!fn) return null;
  try {
    return fn(code, filePath);
  } catch (e) {
    return { language: 'unknown', ok: false, degraded: true, error: e.message, imports: [], exports: [], methods: [], calls: [] };
  }
}
