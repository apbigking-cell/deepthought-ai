import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, normalize } from 'path';
import { config } from '../../config.js';

// 文件操作（沙盒化：限制在项目目录内）
const PROJECT_ROOT = normalize(resolve(process.cwd()));

function sandboxPath(filePath) {
  const abs = normalize(resolve(PROJECT_ROOT, filePath));
  if (!abs.startsWith(PROJECT_ROOT)) throw new Error('Access denied: path outside project');
  return abs;
}

export const readFileDef = {
  name: 'read_file',
  description: 'Read the contents of a file within the project directory.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to project root' },
    },
    required: ['path'],
  },
};

export async function readFileHandler(args) {
  const p = sandboxPath(args.path);
  if (!existsSync(p)) throw new Error(`File not found: ${args.path}`);
  const content = readFileSync(p, 'utf-8');
  return content.slice(0, 10000); // 截断
}

export const writeFileDef = {
  name: 'write_file',
  description: 'Write content to a file within the project directory.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to project root' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
};

export async function writeFileHandler(args) {
  const p = sandboxPath(args.path);
  writeFileSync(p, args.content, 'utf-8');
  return { success: true, path: args.path, bytes: args.content.length };
}
