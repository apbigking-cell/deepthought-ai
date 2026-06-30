import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve, normalize } from 'path';
import { config } from '../../config.js';
import { approvalQueue } from '../approval.js';

const execAsync = promisify(exec);
const WORKSPACE_ROOT = normalize(resolve(config.persona.workspaceRoot));

// 命令白名单前缀（只读/安全的命令即使未开放exec也可直接跑）
const SAFE_PREFIXES = ['ls', 'dir', 'cat', 'type', 'pwd', 'echo', 'node -v', 'node --version', 'npm -v', 'git status', 'git log', 'git diff'];

function isSafe(cmd) {
  const c = cmd.trim().toLowerCase();
  return SAFE_PREFIXES.some(p => c === p || c.startsWith(p + ' '));
}

async function runCommand(command, cwd) {
  const workdir = normalize(resolve(cwd || WORKSPACE_ROOT));
  // 沙箱：工作目录必须在 workspace 根之内
  const safeCwd = workdir.startsWith(WORKSPACE_ROOT) ? workdir : WORKSPACE_ROOT;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: safeCwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
    return out.slice(0, 6000) || '(无输出)';
  } catch (e) {
    return `命令失败: ${e.message}`.slice(0, 4000);
  }
}

export const shellDef = {
  name: 'run_shell',
  description: '在你的工作目录(沙箱)中执行一条shell命令。用于跑测试、安装依赖、git操作、运行脚本等。危险命令会进入人类审批队列。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的shell命令' },
    },
    required: ['command'],
  },
};

export async function shellHandler(args, context = {}) {
  const command = (args.command || '').trim();
  if (!command) return 'Error: 空命令';
  const cwd = context.workDir || WORKSPACE_ROOT;

  // 允许执行：全局开关 / 只读安全命令 → 直接跑
  if (config.terminal.allowExec || isSafe(command)) {
    return await runCommand(command, cwd);
  }

  // 否则进入审批队列（不阻塞心跳）
  const id = approvalQueue.submit({
    personaId: context.personaId,
    type: 'shell',
    command,
    cwd,
    run: () => runCommand(command, cwd),
  });
  return `[需要批准] 命令已提交审批队列(#${id}): ${command}\n（在WebUI或终端用 /approve ${id} 批准后才会执行）`;
}
