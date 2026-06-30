import { StdioTransport } from './transports/stdio.js';

// MCP多服务器管理器
export class McpManager {
  constructor() {
    this.servers = new Map(); // name → { transport, tools }
  }

  // 添加服务器配置
  addServer(name, command, args = []) {
    if (this.servers.has(name)) throw new Error(`MCP server already exists: ${name}`);
    const transport = new StdioTransport(command, args);
    this.servers.set(name, { transport, tools: [] });
    return transport;
  }

  // 连接所有服务器
  async connectAll() {
    const results = [];
    for (const [name, { transport }] of this.servers) {
      try {
        console.log(`[MCP] Connecting ${name} (${transport.command})...`);
        await transport.connect();
      } catch (e) {
        console.error(`[MCP] ${name} connection failed:`, e.message);
        results.push({ name, status: 'error', error: e.message });
      }
    }
    // 连接后获取工具列表
    for (const [name, server] of this.servers) {
      if (server.transport.isConnected) {
        try {
          server.tools = await server.transport.listTools();
          console.log(`[MCP] ${name}: ${server.tools.length} tools discovered`);
          results.push({ name, status: 'connected', tools: server.tools.length });
        } catch (e) {
          console.error(`[MCP] ${name} tool discovery failed:`, e.message);
          results.push({ name, status: 'no_tools', error: e.message });
        }
      }
    }
    return results;
  }

  // 动态添加服务器
  async addAndConnect(name, command, args = []) {
    if (this.servers.has(name)) throw new Error(`Server already exists: ${name}`);
    const transport = this.addServer(name, command, args);
    try {
      await transport.connect();
      if (transport.isConnected) {
        const server = this.servers.get(name);
        server.tools = await transport.listTools();
        return { name, tools: server.tools.length };
      }
    } catch (e) {
      this.servers.delete(name);
      throw e;
    }
  }

  // 动态移除服务器
  async removeServer(name) {
    const server = this.servers.get(name);
    if (!server) throw new Error(`Server not found: ${name}`);
    await server.transport.disconnect();
    this.servers.delete(name);
  }

  // 获取所有服务器的工具定义
  getAllToolDefinitions() {
    const all = [];
    for (const [serverName, { tools }] of this.servers) {
      for (const tool of tools) {
        all.push({ ...tool, _server: serverName });
      }
    }
    return all;
  }

  // 调用指定服务器的工具
  async callTool(name, args) {
    for (const [serverName, { transport, tools }] of this.servers) {
      if (tools.some(t => t.name === name)) {
        return await transport.callTool(name, args);
      }
    }
    throw new Error(`MCP tool not found: ${name}`);
  }

  // 断开所有
  async disconnectAll() {
    for (const [name, { transport }] of this.servers) {
      try {
        await transport.disconnect();
      } catch {}
    }
    this.servers.clear();
  }

  // 状态
  getStatus() {
    const status = [];
    for (const [name, { transport, tools }] of this.servers) {
      status.push({
        name,
        command: transport.command,
        connected: transport.isConnected,
        toolCount: tools.length,
      });
    }
    return status;
  }
}
