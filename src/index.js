// 仿人脑记忆引擎 — 主入口
// 心跳驱动的多Agent记忆系统 + 多角色人格 + 技能工具 + MCP
import { initDatabase, closeDatabase } from './db/sqlite.js';
import { llm } from './llm/deepseek.js';
import { config } from './config.js';
import { InternalState } from './state/internal-state.js';
import {
  SensoryBuffer, WorkingMemory, EpisodicMemory, SemanticMemory,
  ProceduralMemory, MetaMemory, MemoryStore,
} from './memory/index.js';
import {
  PerceptionAgent, EncodingAgent, RetrievalAgent, ResponseAgent,
  CentralExecutive, ConsolidationAgent, CompressionAgent,
  ForgettingAgent, AssociationAgent, MetamemoryAgent,
  ProspectiveAgent, NarrativeAgent,
} from './agents/index.js';
import { QQBot } from './bot/qq.js';
import { WeixinBot, weixinLoginInteractive } from './bot/weixin.js';
import { WebBot } from './bot/web.js';
import { HeartbeatOrchestrator } from './heartbeat/orchestrator.js';
import { PersonaManager } from './persona/manager.js';
import { WebUIServer } from './webui/server.js';
import { PersonaRegistry } from './persona/registry.js';
import { PersonaRouter } from './persona/router.js';
import { ToolRegistry } from './tools/registry.js';
import { ToolExecutor } from './tools/executor.js';
import { calculatorDef, calculatorHandler } from './tools/builtin/calculator.js';
import { timeDef, timeHandler } from './tools/builtin/time.js';
import { readFileDef, readFileHandler, writeFileDef, writeFileHandler } from './tools/builtin/file.js';
import { webSearchDef, webSearchHandler } from './tools/builtin/web.js';
import { shellDef, shellHandler } from './tools/builtin/shell.js';
import { approvalQueue } from './tools/approval.js';
import { McpManager } from './mcp/manager.js';
import { connectMcpToRegistry, disconnectMcpFromRegistry } from './mcp/bridge.js';
import { TerminalController } from './terminal/controller.js';
import { MindRegistry, GoalStore, Scheduler, CognitiveCycle, WorkAgent } from './cognition/index.js';
import { CodeContextAgent, createCodemapTools } from './codemap/index.js';

// ============================================================
// 初始化
// ============================================================

console.log('╔══════════════════════════════════════════╗');
console.log('║        深念  DeepThought v0.3.0              ║');
console.log('║   DeepSeek · 类人智能体 · 实时思考·目标·自主工作 ║');
console.log('╚══════════════════════════════════════════╝');
console.log('');

await initDatabase();
console.log('[Init] Database ready');

const sensoryBuffer = new SensoryBuffer(config.memory.sensoryBufferTtlMs);
const workingMemory = new WorkingMemory();
const episodicMemory = new EpisodicMemory();
const semanticMemory = new SemanticMemory();
const proceduralMemory = new ProceduralMemory();
const metaMemory = new MetaMemory();

const memoryStore = new MemoryStore();
memoryStore.sensory = sensoryBuffer;
memoryStore.working = workingMemory;
memoryStore.episodic = episodicMemory;
memoryStore.semantic = semanticMemory;
memoryStore.procedural = proceduralMemory;
memoryStore.meta = metaMemory;
console.log('[Init] Memory layers: L0~L5 ready');

const internalState = new InternalState();
internalState.emotionLabel = 'neutral';

// 人格系统：旧单例（兼容） + 新注册表
const oldPersona = new PersonaManager();
const personaRegistry = new PersonaRegistry();
const personaRouter = new PersonaRouter(personaRegistry);
console.log(`[Init] Persona: ${oldPersona.profile.name} (默认) | Registry: ${personaRegistry.count}人格`);

// 工具系统
const toolRegistry = new ToolRegistry();
toolRegistry.registerTool('calculator', calculatorDef, calculatorHandler);
toolRegistry.registerTool('get_current_time', timeDef, timeHandler);
toolRegistry.registerTool('read_file', readFileDef, readFileHandler);
toolRegistry.registerTool('write_file', writeFileDef, writeFileHandler);
toolRegistry.registerTool('web_search', webSearchDef, webSearchHandler);
toolRegistry.registerTool('run_shell', shellDef, shellHandler);
// 代码依赖图谱（CodeMap）：上下文 Agent + 工具（构建/查询/放大）
const codeContextAgent = new CodeContextAgent({ llm, config: config.codemap?.context });
for (const t of createCodemapTools({ contextAgent: codeContextAgent, config: config.codemap })) {
  toolRegistry.registerTool(t.name, t.definition, t.handler);
}
const toolExecutor = new ToolExecutor(toolRegistry);
console.log(`[Init] Tools: ${toolRegistry.count} builtin`);

// Agent系统（persona参数化，不再存构造器）
const perceptionAgent = new PerceptionAgent();
const encodingAgent = new EncodingAgent();
const retrievalAgent = new RetrievalAgent(memoryStore);
const responseAgent = new ResponseAgent(null); // persona per-call
const centralExecutive = new CentralExecutive(null);
const consolidationAgent = new ConsolidationAgent(memoryStore);
const compressionAgent = new CompressionAgent(memoryStore);
const forgettingAgent = new ForgettingAgent(memoryStore);
const associationAgent = new AssociationAgent(memoryStore);
const metamemoryAgent = new MetamemoryAgent(memoryStore);
const prospectiveAgent = new ProspectiveAgent();
const narrativeAgent = new NarrativeAgent(memoryStore, oldPersona);
console.log('[Init] All 12 agents ready');

// 认知系统：每人格心智 + 目标 + 自主工作 + 认知循环
const mindRegistry = new MindRegistry();
const goalStore = new GoalStore();
const scheduler = new Scheduler();
const workAgent = new WorkAgent({ toolRegistry, toolExecutor, personaRegistry, goalStore, contextAgent: codeContextAgent });
const cognitiveCycle = new CognitiveCycle({
  perceptionAgent, retrievalAgent, encodingAgent,
  goalStore, workAgent, memoryStore, personaRegistry,
});
// 预热每个人格的 Mind（恢复情绪/意识流）
for (const p of personaRegistry.list()) mindRegistry.get(p.personaId, p.autonomyMode);
console.log(`[Init] Cognition: ${personaRegistry.count} minds, ${goalStore.active(personaRegistry.defaultId).length} active goals (default)`);

// Bot平台
const qqBot = new QQBot();
const weixinBot = new WeixinBot();
const webBot = new WebBot(); // WebUI 在线聊天接入认知管线
// 多微信实例：每个人格可以绑定独立的微信号
const extraWeixinBots = (config.weixinBot.instances || []).map((inst, i) =>
  new WeixinBot({ botToken: inst.token, personaId: inst.personaId, name: inst.name })
);
const allWeixinBots = [weixinBot, ...extraWeixinBots].filter(b => b.botToken);
const bots = [qqBot, webBot, ...allWeixinBots];
const defaultUserId = process.env.QQ_DEFAULT_USER_ID || null;

if (extraWeixinBots.length > 0) {
  console.log(`[Init] Extra WeChat Bots: ${extraWeixinBots.length} (each bound to a persona)`);
  for (const b of extraWeixinBots) {
    console.log(`  - ${b.instanceName} → persona: ${b.boundPersonaId || '(default)'}`);
  }
}

// MCP
let mcpManager = null;
if (config.mcp.servers?.length) {
  mcpManager = new McpManager();
  for (const s of config.mcp.servers) {
    mcpManager.addServer(s.name, s.command, s.args);
  }
  console.log(`[Init] MCP: ${config.mcp.servers.length} servers configured`);
}

// 终端
const terminal = new TerminalController(personaRegistry, personaRouter, toolRegistry, mcpManager);

// WebUI（可CLI参数启动也可终端命令启动）
let webui = null;
const cliArgs = process.argv.slice(2);
const startWebUi = cliArgs.includes('--webui') || cliArgs.includes('-w') || cliArgs.includes('webui');

// 组装编排器
const orchestrator = new HeartbeatOrchestrator({
  internalState, sensoryBuffer, workingMemory, memoryStore,
  perceptionAgent, encodingAgent, retrievalAgent, responseAgent,
  centralExecutive,
  consolidationAgent, compressionAgent, forgettingAgent,
  associationAgent, metamemoryAgent,
  prospectiveAgent, narrativeAgent,
  bots, defaultUserId,
  personaRegistry, personaRouter, oldPersona,
  toolRegistry, toolExecutor,
  // 认知层
  mindRegistry, goalStore, scheduler, cognitiveCycle, workAgent,
});

// ============================================================
// 启动
// ============================================================

async function main() {
  console.log('');
  console.log('[Boot] AI Model: DeepSeek V4 Pro (1M context)');
  console.log(`[Boot] Heartbeat: ${config.heartbeat.intervalMs}ms`);

  try {
    console.log('[Boot] Testing DeepSeek API...');
    await llm.quick('你是一个记忆引擎。回答OK。', 'ping');
    console.log('[Boot] DeepSeek API: OK');
  } catch (e) {
    console.warn('[Boot] DeepSeek API test failed:', e.message);
  }

  // 连接MCP
  if (mcpManager && config.mcp.autoConnect) {
    try {
      console.log('[Boot] Connecting MCP servers...');
      await mcpManager.connectAll();
      connectMcpToRegistry(mcpManager, toolRegistry);
      console.log(`[Boot] MCP: ${toolRegistry.count} total tools`);
    } catch (e) {
      console.warn('[Boot] MCP connection failed:', e.message);
    }
  }

  // 先启动WebUI（不依赖任何bot）
  if (startWebUi) {
    webui = new WebUIServer({
      internalState, workingMemory, memoryStore, orchestrator,
      personaRegistry, personaRouter, toolRegistry, mcpManager,
      responseAgent, mindRegistry, goalStore, approvalQueue, bots, webBot,
    });
    webui.start();
  }

  // 连接微信（异步，不阻塞启动）
  if (config.weixinBot.botToken) {
    weixinBot.connect().then(() => console.log('[Boot] WeChat Bot: Connected'))
      .catch(e => console.warn('[Boot] WeChat Bot:', e.message));
  }
  // 连接额外的微信实例（绑定人格）
  for (const b of extraWeixinBots) {
    b.connect().then(() => console.log(`[Boot] WeChat Bot (${b.instanceName}→${b.boundPersonaId}): Connected`))
      .catch(e => console.warn(`[Boot] WeChat Bot (${b.instanceName}):`, e.message));
  }

  orchestrator.start();

  console.log('');
  console.log('┌──────────────────────────────────────────────────┐');
  console.log('│   深念已启动 · 多角色人格 · 技能工具 · MCP        │');
  if (webui?.running) console.log(`│   WebUI: http://localhost:${webui.port}                  │`);
  console.log('└──────────────────────────────────────────────────┘');
  console.log('');

  const qqConfigured = !!(config.qqBot.appId && config.qqBot.clientSecret);
  const wxConfigured = !!config.weixinBot.botToken;

  console.log('[Terminal] 命令 (中/英):');
  if (qqConfigured) console.log('  /qq                    连接QQ');
  if (!wxConfigured) console.log('  /weixin                微信扫码登录');
  console.log('  /personas  /人格列表    列出人格');
  console.log('  /persona   /人格 <id>   切换/注册/绑定人格');
  console.log('  /tools     /工具        列出工具');
  console.log('  /webui                 启动Web管理面板');
  console.log('  /mcp 状态|添加|移除     MCP动态管理');
  console.log('  /skill /技能 列表|添加|移除  动态技能');
  console.log('  /think /意识流 [人格]   查看内心独白');
  console.log('  /goals /目标 [人格]     查看目标进展');
  console.log('  /approve [id]          查看/批准待执行命令  /reject [id]');
  console.log('  /stats /状态  /mood /情绪  /mem /记忆  /quit');
  console.log('');

  // 终端输入处理
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', async (data) => {
    const text = data.toString().trim();
    if (!text) return;

    if (text === '/quit' || text === '/exit') {
      console.log('[Terminal] Shutting down...');
      orchestrator.stop();
      await qqBot.disconnect();
      await weixinBot.disconnect();
      if (mcpManager) { disconnectMcpFromRegistry(mcpManager, toolRegistry); await mcpManager.disconnectAll(); }
      closeDatabase();
      process.exit(0);
    }

    // 先尝试终端命令系统
    const cmdMatch = text.match(/^\/(\w+)\s*(.*)/);
    if (cmdMatch) {
      const [, cmd, args] = cmdMatch;
      const result = await terminal.handle(cmd, args);
      if (result !== null) { console.log(result); return; }

      // 旧命令保留
      if (cmd === 'qq') {
        if (!qqConfigured) { console.log('[QQ] 未配置凭证'); return; }
        try { await qqBot.connect(); console.log('[QQ] 已连接'); if (!bots.includes(qqBot)) bots.push(qqBot); }
        catch (e) { console.log(`[QQ] 连接失败: ${e.message}`); }
        return;
      }
      if (cmd === 'weixin') {
        if (wxConfigured) {
          try { await weixinBot.connect(); console.log('[WeChat] 已连接'); }
          catch (e) { console.log(`[WeChat] 连接失败: ${e.message}`); }
          return;
        }
        const result = await weixinLoginInteractive();
        if (result.success) {
          console.log(`[WeChat] Token: ${result.token}`);
          weixinBot.botToken = result.token;
          if (!bots.includes(weixinBot)) bots.push(weixinBot);
          await weixinBot.connect();
        }
        return;
      }
      if (cmd === 'stats' || cmd === '状态') {
        const s = orchestrator.getStats();
        console.log(`\n心跳:${s.ticksTotal} 消息:${s.messagesProcessed} 循环:${s.cyclesRun} 念头:${s.thoughtsGenerated} 回复:${s.responsesGenerated} 工作:${s.worksDone} 主动:${s.initiationsMade} 编码:${s.memoriesEncoded} 工具:${toolRegistry.count}\n`);
        return;
      }
      if (cmd === 'mood' || cmd === '情绪') {
        const pid = args.trim() || personaRegistry.defaultId;
        const persona = personaRegistry.getPersona(pid);
        const s = mindRegistry.get(pid, persona?.autonomyMode).snapshot();
        console.log(`\n[${persona?.name || pid}] 情绪:${s.emotionLabel} valence:${s.valence.toFixed(2)} arousal:${s.arousal.toFixed(2)} energy:${(s.energy*100).toFixed(0)}% social:${(s.socialDrive*100).toFixed(0)}%`);
        console.log(`当前念头: ${s.currentThought || '(无)'}\n`);
        return;
      }
      if (cmd === 'think' || cmd === '念头' || cmd === '意识流') {
        const pid = args.trim() || personaRegistry.defaultId;
        const persona = personaRegistry.getPersona(pid);
        const thoughts = mindRegistry.get(pid, persona?.autonomyMode).recentThoughts(15);
        console.log(`\n[${persona?.name || pid}] 意识流(${thoughts.length}):`);
        for (const t of thoughts) console.log(`  · ${t.content}`);
        console.log('');
        return;
      }
      if (cmd === 'goals' || cmd === '目标') {
        const pid = args.trim() || personaRegistry.defaultId;
        const persona = personaRegistry.getPersona(pid);
        const gs = goalStore.active(pid);
        console.log(`\n[${persona?.name || pid}] 目标(${gs.length}):`);
        for (const g of gs) console.log(`  [${g.kind}|${(g.progress*100|0)}%] ${g.title}`);
        console.log('');
        return;
      }
      if (cmd === 'approve' || cmd === '批准') {
        const id = args.trim();
        if (!id) { const p = approvalQueue.list(); console.log(`\n待批准(${p.length}):`); for (const r of p) console.log(`  #${r.id} [${r.personaId}] ${r.command}`); console.log(''); return; }
        const r = await approvalQueue.approve(id);
        console.log(r.ok ? `已批准 #${id}:\n${r.result}` : `批准失败: ${r.error}`);
        return;
      }
      if (cmd === 'reject' || cmd === '拒绝') {
        const r = approvalQueue.reject(args.trim());
        console.log(r.ok ? `已拒绝 #${args.trim()}` : `失败: ${r.error}`);
        return;
      }
      if (cmd === 'mem' || cmd === '记忆') {
        const r = workingMemory.getActive();
        console.log(`\n工作记忆(${r.length}):`);
        for (const c of r) console.log(`  [${c.type}] ${c.content?.slice(0,120)}`);
        console.log('');
        return;
      }
      if (cmd === 'webui') {
        if (webui?.running) {
          console.log(`WebUI已在运行: http://localhost:${webui.port}`);
        } else {
          webui = new WebUIServer({
            internalState, workingMemory, memoryStore, orchestrator,
            personaRegistry, personaRouter, toolRegistry, mcpManager,
            responseAgent, mindRegistry, goalStore, approvalQueue, bots, webBot,
          });
          webui.start();
        }
        return;
      }
    }
  });

  process.stdin.resume();
}

// 优雅退出
async function shutdown() {
  if (webui) await webui.stop();
  orchestrator.stop();
  await qqBot.disconnect();
  await weixinBot.disconnect();
  for (const b of extraWeixinBots) await b.disconnect();
  if (mcpManager) { disconnectMcpFromRegistry(mcpManager, toolRegistry); await mcpManager.disconnectAll(); }
  closeDatabase();
}
process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));

main().catch(err => { console.error('[Fatal]', err); process.exit(1); });
