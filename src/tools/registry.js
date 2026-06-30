// 工具注册表 —— 管理所有可调用工具（内置 + MCP）
export class ToolRegistry {
  constructor() {
    this.tools = new Map(); // name → { definition, handler, source }
  }

  // 注册工具
  registerTool(name, definition, handler, source = 'builtin') {
    this.tools.set(name, { definition, handler, source });
  }

  // 注销
  unregisterTool(name) {
    return this.tools.delete(name);
  }

  // 批量注册（用于MCP工具导入）
  registerBatch(toolDefs, handlerFactory, source = 'mcp') {
    for (const def of toolDefs) {
      this.tools.set(def.name, {
        definition: {
          name: def.name,
          description: def.description || '',
          parameters: def.parameters || def.inputSchema || { type: 'object', properties: {} },
        },
        handler: handlerFactory(def.name),
        source,
      });
    }
  }

  // 按来源注销
  unregisterBySource(source) {
    for (const [name, tool] of this.tools) {
      if (tool.source === source) this.tools.delete(name);
    }
  }

  // 获取DeepSeek function calling格式的工具定义
  getToolDefinitions(personaId = null, personaRegistry = null) {
    const defs = [];
    for (const [name, tool] of this.tools) {
      // 检查工具权限
      if (personaId && personaRegistry) {
        const persona = personaRegistry.getPersona(personaId);
        const policy = persona?.toolPolicy || {};
        if (policy.allowed_tools?.[0] !== '*' && !policy.allowed_tools?.includes(name)) continue;
        if (policy.denied_tools?.includes(name)) continue;
      }
      defs.push({
        type: 'function',
        function: {
          name: tool.definition.name,
          description: tool.definition.description,
          parameters: tool.definition.parameters,
        },
      });
    }
    return defs;
  }

  // 执行工具
  async executeTool(name, args, context = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return await tool.handler(args, context);
  }

  // 动态注册技能（运行时代码，source='skill'）
  registerSkill(name, description, code) {
    // 将代码包装为async函数
    const handler = new Function('args', 'context', `
      return (async () => {
        ${code}
      })();
    `);
    this.registerTool(name, {
      name,
      description,
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Input for the skill' },
        },
      },
    }, handler, 'skill');
  }

  // 列出所有工具
  list() {
    return [...this.tools.entries()].map(([name, t]) => ({
      name,
      description: t.definition.description,
      source: t.source,
    }));
  }

  get count() { return this.tools.size; }
}
