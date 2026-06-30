import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

function parseMcpServers() {
  const servers = [];
  for (let i = 1; i <= 10; i++) {
    const name = process.env[`MCP_SERVER_${i}_NAME`];
    const command = process.env[`MCP_SERVER_${i}_COMMAND`];
    if (!name || !command) continue;
    const argsStr = process.env[`MCP_SERVER_${i}_ARGS`] || '';
    servers.push({ name, command, args: argsStr.split(/\s+/).filter(Boolean) });
  }
  return servers;
}

export const config = {
  llm: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    maxTokens: 4096,
    temperature: 0.7,
  },

  qqBot: {
    appId: process.env.QQ_BOT_APP_ID || '',
    clientSecret: process.env.QQ_BOT_CLIENT_SECRET || '',
    authBase: 'https://bots.qq.com',
    apiBase: 'https://api.sgroup.qq.com',
  },

  weixinBot: {
    botToken: process.env.WEIXIN_BOT_TOKEN || '',
    // 多微信实例：每个人格可以绑定独立的微信号
    // 格式：WEIXIN_BOT_2_TOKEN=xxx, WEIXIN_BOT_2_PERSONA=furina
    //       WEIXIN_BOT_3_TOKEN=yyy, WEIXIN_BOT_3_PERSONA=xiaoyu
    instances: (() => {
      const list = [];
      for (let i = 2; i <= 10; i++) {
        const token = process.env[`WEIXIN_BOT_${i}_TOKEN`];
        if (!token) continue;
        const persona = process.env[`WEIXIN_BOT_${i}_PERSONA`] || '';
        const name = process.env[`WEIXIN_BOT_${i}_NAME`] || `weixin-${i}`;
        list.push({ token, personaId: persona, name });
      }
      return list;
    })(),
  },

  location: {
    city: process.env.LOCATION_CITY || '杭州',
    region: process.env.LOCATION_REGION || '华东',
    country: process.env.LOCATION_COUNTRY || '中国',
    timezone: process.env.LOCATION_TIMEZONE || 'Asia/Shanghai',
    latitude: parseFloat(process.env.LOCATION_LAT || '30.25'),
    longitude: parseFloat(process.env.LOCATION_LON || '120.17'),
  },

  heartbeat: {
    intervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '1000'),
    microSleepIntervalTicks: parseInt(process.env.MICRO_SLEEP_INTERVAL_TICKS || '3600'),
    microSleepDurationMs: parseInt(process.env.MICRO_SLEEP_DURATION_MS || '5000'),
  },

  mcp: {
    servers: parseMcpServers(),
    autoConnect: process.env.MCP_AUTO_CONNECT !== 'false',
  },

  terminal: {
    allowExec: process.env.TERMINAL_ALLOW_EXEC === 'true',
  },

  // 认知循环（意识流 + 目标 + 自主工作）
  cognition: {
    // 自发思考最小间隔(ms)：被动模式下设为极大值 = 不发消息不思考
    spontaneousThinkMs: parseInt(process.env.COGNITION_THINK_MS || '86400000'), // 默认 24h

    // 高唤醒/有待办时的加速下限
    minThinkMs: parseInt(process.env.COGNITION_MIN_THINK_MS || '600000'),
    // 工作型人格单次心跳工作循环的最大工具轮数与时间盒(ms)
    workMaxRounds: parseInt(process.env.WORK_MAX_ROUNDS || '6'),
    workBudgetMs: parseInt(process.env.WORK_BUDGET_MS || '60000'),

    // 按场景分档的上下文预算与推理强度（控成本核心）
    // chat=陪伴/闲聊：精简上下文 + 低推理，频繁触发也便宜
    // work=编程/工作：放开到接近 1M 大窗口 + 高推理，保证能力
    profiles: {
      chat: {
        contextCharBudget: parseInt(process.env.COGNITION_CHAT_CHARS || '6000'),
        episodicLimit: parseInt(process.env.COGNITION_CHAT_EPISODIC || '8'),
        thoughtLimit: parseInt(process.env.COGNITION_CHAT_THOUGHTS || '10'),
        relevantLimit: parseInt(process.env.COGNITION_CHAT_RELEVANT || '4'),
        reasoningEffort: process.env.COGNITION_CHAT_REASONING || 'low',
        maxTokens: parseInt(process.env.COGNITION_CHAT_MAXTOKENS || '1536'),
      },
      work: {
        // 允许接近 1M：默认 60万字符（中文约≈36万token，留足余量），可调更高
        contextCharBudget: parseInt(process.env.COGNITION_WORK_CHARS || '600000'),
        episodicLimit: parseInt(process.env.COGNITION_WORK_EPISODIC || '60'),
        thoughtLimit: parseInt(process.env.COGNITION_WORK_THOUGHTS || '40'),
        relevantLimit: parseInt(process.env.COGNITION_WORK_RELEVANT || '8'),
        reasoningEffort: process.env.COGNITION_WORK_REASONING || 'high',
        maxTokens: parseInt(process.env.COGNITION_WORK_MAXTOKENS || '4096'),
      },
    },
  },

  // 人格默认工作目录根（沙箱）
  persona: {
    workspaceRoot: process.env.PERSONA_WORKSPACE_ROOT || resolve(__dirname, '..', 'workspace'),
  },

  // 代码依赖图谱（CodeMap）：分层可缩放的 md 依赖图 + 上下文 Agent
  codemap: {
    // 构建参数：控制各层 md 大小，保证 DeepSeek 读取轻量
    builder: {
      // 文件数 <= 此值则不展开 modules 层（只 index + files 两层）
      smallProjectMaxFiles: parseInt(process.env.CODEMAP_SMALL_MAX_FILES || '12'),
      // 单文件 md 中方法级调用连线最多画多少条（控大小）
      maxEdgesPerFile: parseInt(process.env.CODEMAP_MAX_EDGES || '40'),
      // 单文件 md 中最多列出多少方法
      maxMethodsListed: parseInt(process.env.CODEMAP_MAX_METHODS || '60'),
      // 是否生成 LLM 摘要（默认关，省成本；静态分析已足够）
      includeSummary: process.env.CODEMAP_SUMMARY === 'true',
    },
    // 上下文 Agent：逐层放大取上下文的预算（控 token）
    context: {
      maxModules: parseInt(process.env.CODEMAP_CTX_MAX_MODULES || '6'),
      maxFiles: parseInt(process.env.CODEMAP_CTX_MAX_FILES || '8'),
      perFileMdBudget: parseInt(process.env.CODEMAP_CTX_FILE_MD || '2000'),
      perFileCodeBudget: parseInt(process.env.CODEMAP_CTX_FILE_CODE || '2400'),
      // 单次取上下文的总字符预算（编程场景可放大到接近 1M 窗口）
      totalBudget: parseInt(process.env.CODEMAP_CTX_TOTAL || '60000'),
      codeContextLines: parseInt(process.env.CODEMAP_CTX_CODE_LINES || '4'),
    },
  },

  memory: {
    workingMemoryCapacity: 15,
    workingMemoryTtlMs: 600000, // 10分钟——跨对话间隔也保留
    sensoryBufferTtlMs: 2000,
    episodicRetentionDays: 7,
    consolidationThreshold: 3, // 访问N次后触发巩固
    defaultDecayHalfLife: 7 * 24 * 3600 * 1000, // 7天半衰期(ms)
  },

  emotion: {
    valenceInertia: 0.99,       // 每秒保持率
    arousalInertia: 0.95,
    dominanceInertia: 0.98,
    socialDriveRise: 0.0003,    // 每秒增量(无聊时)
    socialDriveDecay: 0.05,     // 社交后减少量
    boredomThreshold: 0.7,      // 触发主动社交
    angerThreshold: -0.5,       // 冷处理阈值
  },

  db: {
    path: resolve(__dirname, '..', 'data', 'memory.db'),
  },
};
