import { llm } from '../llm/deepseek.js';

// 工具执行循环 —— LLM调用 → 执行工具 → 结果注入 → 重复
export class ToolExecutor {
  constructor(registry) {
    this.registry = registry;
  }

  // 执行带工具的对话（maxTokens 可配：编程场景需要更大输出以写完整代码）
  async executeWithTools({ systemPrompt, messages, tools, context = {}, maxRounds = 5, maxTokens = 1024 }) {
    const convoMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    for (let round = 0; round < maxRounds; round++) {
      const result = await llm.chat({
        messages: convoMessages,
        tools,
        temperature: 0.7,
        maxTokens,
      });

      // 检查是否有工具调用
      const toolCalls = result.tool_calls;
      if (!toolCalls?.length) {
        // 纯文本回复 → 结束
        return result.content || '';
      }

      // 追加assistant消息（含tool_calls）
      convoMessages.push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: toolCalls,
      });

      // 执行每个工具调用
      for (const tc of toolCalls) {
        const toolName = tc.function?.name;
        if (!toolName) continue;

        let toolResult;
        try {
          const args = JSON.parse(tc.function.arguments || '{}');
          console.log(`[Tool] ${toolName}(${JSON.stringify(args).slice(0, 80)})`);
          toolResult = await this.registry.executeTool(toolName, args, context);
          if (typeof toolResult === 'object' && toolResult !== null) toolResult = JSON.stringify(toolResult);
        } catch (e) {
          toolResult = `Error: ${e.message}`;
          console.error(`[Tool] ${toolName} failed:`, e.message);
        }

        // 追加工具结果
        convoMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: String(toolResult).slice(0, 4000),
        });
      }
    }

    // maxRounds耗尽 → 最后尝试生成文本回复
    const final = await llm.chat({
      messages: convoMessages,
      temperature: 0.7,
      maxTokens: Math.min(maxTokens, 1024),
    });
    return final.content || '（处理超时，请简化请求）';
  }
}
