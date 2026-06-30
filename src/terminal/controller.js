import { config } from '../config.js';

// 终端命令控制器
export class TerminalController {
  constructor(personaRegistry, personaRouter, toolRegistry, mcpManager) {
    this.personaRegistry = personaRegistry;
    this.personaRouter = personaRouter;
    this.toolRegistry = toolRegistry;
    this.mcpManager = mcpManager;
  }

  async handle(cmd, args) {
    // 中英双语命令别名
    switch (cmd) {
      case 'personas': case '人格列表': return this._listPersonas();
      case 'persona': case '人格': return this._personaCmd(args);
      case 'tools': case '工具': case '工具列表': return this._listTools();
      case 'mcp': return this._mcpCmd(args);
      case 'skill': case '技能': return this._skillCmd(args);
      case 'exec': case '执行': return this._execCmd(args);
      default: return null;
    }
  }

  _listPersonas() {
    const list = this.personaRegistry.list();
    if (list.length === 0) return '（无已注册人格）';
    return list.map(p => {
      const s = p.getSummary();
      return `[${p.personaId}] ${p.name} (${p.type}) - ${s.mood || ''}`;
    }).join('\n');
  }

  async _personaCmd(args) {
    if (!args || args === 'list' || args === '列表') return this._listPersonas();

    const parts = args.split(/\s+/);
    const sub = parts[0];

    // register / 注册
    if ((sub === 'register' || sub === '注册') && parts[1]) {
      try {
        const ctx = this.personaRegistry.registerSeed(parts[1]);
        return `已注册人格: ${ctx.name} (${ctx.personaId})`;
      } catch (e) {
        return `注册失败: ${e.message}`;
      }
    }

    // assign / 绑定
    if ((sub === 'assign' || sub === '绑定') && parts.length >= 4) {
      const [_, platform, userId, personaId] = parts;
      const result = this.personaRouter.assignPersona(platform, userId, personaId);
      return `已绑定: ${userId} → ${personaId}`;
    }

    // 默认：切换活跃人格
    try {
      this.personaRegistry.activate(args);
      return `已切换至人格: ${args}`;
    } catch (e) {
      return `切换失败: ${e.message}\n用法: /人格 列表|注册|绑定|<人格ID>`;
    }
  }

  _listTools() {
    const list = this.toolRegistry.list();
    if (list.length === 0) return '（无已注册工具）';
    return list.map(t => `  [${t.source}] ${t.name} - ${t.description || ''}`).join('\n');
  }

  async _mcpCmd(args) {
    if (!this.mcpManager) return 'MCP未配置';

    if (!args || args === 'status' || args === '状态') {
      const status = this.mcpManager.getStatus();
      if (status.length === 0) return '无MCP服务器';
      return status.map(s =>
        `  ${s.name}: ${s.connected ? '已连接' : '断开'} (${s.toolCount} tools)`
      ).join('\n');
    }

    if (args === 'connect' || args === '连接') {
      try {
        await this.mcpManager.connectAll();
        const { connectMcpToRegistry } = await import('../mcp/bridge.js');
        connectMcpToRegistry(this.mcpManager, this.toolRegistry);
        return 'MCP已连接';
      } catch (e) {
        return `MCP连接失败: ${e.message}`;
      }
    }

    if (args === 'disconnect' || args === '断开') {
      await this.mcpManager.disconnectAll();
      return 'MCP已断开';
    }

    // 动态添加: /mcp add <name> <command> <args...>
    const addMatch = args?.match(/^(?:add|添加)\s+(\S+)\s+(\S+)\s*(.*)/);
    if (addMatch) {
      try {
        const [, name, command, argsStr] = addMatch;
        const cmdArgs = argsStr ? argsStr.split(/\s+/) : [];
        const result = await this.mcpManager.addAndConnect(name, command, cmdArgs);
        const { connectMcpToRegistry } = await import('../mcp/bridge.js');
        connectMcpToRegistry(this.mcpManager, this.toolRegistry);
        return `MCP已添加: ${name} (${result.tools} tools)`;
      } catch (e) {
        return `MCP添加失败: ${e.message}`;
      }
    }

    // 动态移除: /mcp remove <name>
    const rmMatch = args?.match(/^(?:remove|rm|移除|删除)\s+(\S+)/);
    if (rmMatch) {
      try {
        await this.mcpManager.removeServer(rmMatch[1]);
        const { disconnectMcpFromRegistry } = await import('../mcp/bridge.js');
        disconnectMcpFromRegistry(this.mcpManager, this.toolRegistry);
        return `MCP已移除: ${rmMatch[1]}`;
      } catch (e) {
        return `MCP移除失败: ${e.message}`;
      }
    }

    return '用法: /mcp 状态|连接|断开|添加 <name> <cmd> <args>|移除 <name>';
  }

  // === /skill 技能 ===
  async _skillCmd(args) {
    if (!args || args === 'list' || args === '列表') return this._listTools();

    const parts = args.split(/\s+/);
    const sub = parts[0];

    // /skill add <name> <description> <code>
    if ((sub === 'add' || sub === '添加') && parts.length >= 3) {
      // 参数: name description  + 剩下的作为code
      const name = parts[1];
      const descEnd = parts.findIndex((p, i) => i >= 2 && p.includes('return')) || parts.length;
      const desc = parts.slice(2, descEnd).join(' ');
      const code = parts.slice(descEnd).join(' ') || parts.slice(2).join(' ');

      try {
        this.toolRegistry.registerSkill(name, desc || name, code);
        return `技能已添加: ${name}`;
      } catch (e) {
        return `技能添加失败: ${e.message}`;
      }
    }

    // /skill remove <name>
    if ((sub === 'remove' || sub === 'rm' || sub === '移除') && parts[1]) {
      this.toolRegistry.unregisterTool(parts[1]);
      return `技能已移除: ${parts[1]}`;
    }

    return '用法: /技能 列表|添加 <name> <描述> <code>|移除 <name>';
  }

  async _execCmd(args) {
    if (!args) return '用法: /exec <command>';
    const { execSync } = await import('child_process');
    try {
      const output = execSync(args, { encoding: 'utf-8', timeout: 30000, cwd: process.cwd() });
      return output.slice(0, 2000) || '(无输出)';
    } catch (e) {
      return `执行失败: ${e.message}`;
    }
  }
}
