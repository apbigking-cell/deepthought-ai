import { config } from '../config.js';

const { apiKey, baseUrl, model, maxTokens, temperature } = config.llm;

// 归一化 DeepSeek 返回的 message：同时保留 content / reasoning / tool_calls
function normalizeMessage(message, usage) {
  const reasoning = message?.reasoning_content || message?.reasoning || null;
  return {
    content: message?.content || '',
    reasoning,                       // 推理内容 = 内心独白原料
    toolCalls: message?.tool_calls || null,
    tool_calls: message?.tool_calls || null, // 向后兼容旧调用方
    role: message?.role || 'assistant',
    usage: usage || null,
    raw: message,
  };
}

export class DeepSeekClient {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || apiKey;
    this.baseUrl = opts.baseUrl || baseUrl;
    this.model = opts.model || model;
    this.defaultMaxTokens = opts.maxTokens || maxTokens;
    this.defaultTemperature = opts.temperature || temperature;
  }

  async chat({ messages, tools, maxTokens, temperature, reasoningEffort, stream = false }) {
    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens || this.defaultMaxTokens,
      temperature: temperature ?? this.defaultTemperature,
      stream,
    };

    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    if (reasoningEffort) {
      body.reasoning_effort = reasoningEffort;
    }

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`DeepSeek API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return normalizeMessage(data.choices[0].message, data.usage);
  }

  // Quick completion for simple tasks (non-thinking, low temp)
  async quick(systemPrompt, userContent) {
    return this.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      maxTokens: 1024,
    });
  }

  // Deep thinking for complex tasks
  async think(systemPrompt, userContent) {
    return this.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      reasoningEffort: 'max',
      maxTokens: 4096,
    });
  }

  // 认知循环专用：深度思考，返回 { content, reasoning, usage }
  // 系统提示固定前缀置顶（利于 prompt cache），可携带大上下文
  async deepThink({ system, user, messages, reasoningEffort = 'high', maxTokens = 8192, temperature = 0.7 }) {
    const msgs = messages || [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    return this.chat({ messages: msgs, reasoningEffort, maxTokens, temperature });
  }

  // Agent-style with tools
  async agent({ systemPrompt, userContent, tools, reasoningEffort = 'high' }) {
    return this.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      tools,
      reasoningEffort,
      maxTokens: 4096,
    });
  }

  // 流式聊天（返回async generator）。
  // yield 对象 { type: 'reasoning' | 'content', text }
  async *chatStream({ messages, temperature, maxTokens, reasoningEffort }) {
    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens || this.defaultMaxTokens,
      temperature: temperature ?? this.defaultTemperature,
      stream: true,
    };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`DeepSeek API error ${res.status}: ${err}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content };
            if (delta?.content) yield { type: 'content', text: delta.content };
          } catch {}
        }
      }
    }
  }

  // 生成记忆搜索词（模式补全：将模糊消息转为精准搜索语句）
  async generateSearchQuery(userMessage, conversationContext = '') {
    const result = await this.quick(
      `你是记忆搜索引擎。用户的对话消息有时很模糊（如"为什么""然后呢""上次那个"），
你需要结合对话上下文，把消息转化为具体的记忆搜索关键词。

返回JSON: {"search_terms":["关键词1","关键词2","关键词3"], "inferred_topic":"推测的话题", "needs_context":true/false}`,

      `对话上文: ${conversationContext || '无'}
用户消息: ${userMessage}`
    );

    try {
      const jsonStr = (result.content || '').match(/\{[\s\S]*\}/)?.[0] || '{}';
      return JSON.parse(jsonStr);
    } catch {
      return { search_terms: [userMessage], inferred_topic: userMessage, needs_context: false };
    }
  }
}

// Singleton
export const llm = new DeepSeekClient();
