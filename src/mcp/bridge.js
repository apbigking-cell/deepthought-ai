// MCP → ToolRegistry 桥接
export function connectMcpToRegistry(mcpManager, toolRegistry) {
  const defs = mcpManager.getAllToolDefinitions();
  toolRegistry.registerBatch(
    defs,
    (toolName) => async (args, context) => {
      return await mcpManager.callTool(toolName, args);
    },
    'mcp'
  );
  console.log(`[MCP Bridge] Registered ${defs.length} tools from MCP servers`);
  return defs.length;
}

export function disconnectMcpFromRegistry(mcpManager, toolRegistry) {
  toolRegistry.unregisterBySource('mcp');
}
