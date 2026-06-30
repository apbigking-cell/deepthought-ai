import { mkdirSync } from 'fs';
import { resolve, normalize } from 'path';
import { config } from '../config.js';
import { refreshProject } from '../codemap/updater.js';

const COG = config.cognition;
const WORKSPACE_ROOT = normalize(resolve(config.persona.workspaceRoot));

// WorkAgent — 工作型人格的自主工作闭环
// 给定一个活跃目标，跑一段时间盒化的多步工具循环（写代码/跑命令/查资料），
// 做完一小段就保存进展，下个心跳继续，从而不卡死1Hz心跳。
export class WorkAgent {
  constructor({ toolRegistry, toolExecutor, personaRegistry, goalStore, contextAgent = null }) {
    this.toolRegistry = toolRegistry;
    this.toolExecutor = toolExecutor;
    this.personaRegistry = personaRegistry;
    this.goalStore = goalStore;
    this.contextAgent = contextAgent;   // CodeContextAgent（可选）
  }

  resolveWorkDir(persona) {
    let dir = persona.workDir;
    if (!dir) dir = resolve(WORKSPACE_ROOT, persona.personaId);
    dir = normalize(resolve(dir));
    if (!dir.startsWith(WORKSPACE_ROOT)) dir = resolve(WORKSPACE_ROOT, persona.personaId);
    try { mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
  }

  // 推进一个目标一小步
  async step(goal, persona, { mind, timeContext } = {}) {
    const workDir = this.resolveWorkDir(persona);
    const tools = this.toolRegistry.getToolDefinitions(persona.personaId, this.personaRegistry);

    const recentNotes = (goal.notes || []).slice(-4).map(n => `- ${n.text}`).join('\n') || '（还没开始）';
    const identity = persona.getResponseContext?.() || `你是${persona.name}`;

    // 取代码依赖上下文（逐层放大，LLM 只选ID，内容本地抓取，省 token）
    let codeContext = '';
    if (this.contextAgent) {
      try {
        const r = await this.contextAgent.gatherContext(workDir, `${goal.title}。${goal.description || ''}`);
        if (r && r.files.length) {
          codeContext = `\n\n相关代码依赖上下文（来自代码图谱，逐层放大）：\n${r.text}`;
        }
      } catch { /* 图谱缺失/失败不影响工作 */ }
    }

    const systemPrompt = `${identity}

你现在在自己的工作目录里独立推进一个目标，像真正的工程师一样工作。
你的工作目录(沙箱)：${workDir}
- 用 read_file / write_file 读写代码文件（路径相对项目根；你的文件放在 workspace/${persona.personaId}/ 下）
- 用 run_shell 跑命令/测试/git（在你的工作目录内执行）
- 用 web_search 查资料
原则：这一轮只做一小段扎实的工作（不要试图一次做完整个项目）。写真实可运行的代码，不要占位。做完后明确总结这一步做了什么、下一步打算做什么。
最后必须单独用一行输出：进度: <0到1之间的小数>`;

    const userPrompt = `目标：${goal.title}
描述：${goal.description || '（无）'}
已完成进展：
${recentNotes}
当前完成度：${(goal.progress * 100 | 0)}%${codeContext}

现在推进下一小步实际工作。`;

    let finalText = '';
    try {
      finalText = await this.toolExecutor.executeWithTools({
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        tools,
        context: { personaId: persona.personaId, workDir },
        maxRounds: COG.workMaxRounds,
        maxTokens: (COG.profiles?.work?.maxTokens) || 4096,
      });
    } catch (e) {
      finalText = `工作中断: ${e.message}`;
    }

    // 解析进度
    let progress = goal.progress;
    const m = finalText.match(/进度[:：]\s*([0-9]*\.?[0-9]+)/);
    if (m) {
      const p = parseFloat(m[1]);
      if (!isNaN(p)) progress = Math.max(goal.progress, Math.min(1, p));
    }
    const summary = finalText.replace(/进度[:：]\s*[0-9.]+/g, '').trim().slice(0, 600) || '推进了一小步';

    // 改完代码后增量更新依赖图谱（本地无 LLM，自动维护，无需 AI 操心）
    if (this.contextAgent) {
      try { refreshProject(workDir); } catch { /* ignore */ }
    }

    // 保存进展
    this.goalStore.addNote(goal.id, summary);
    this.goalStore.setProgress(goal.id, progress, true);
    if (progress >= 1) this.goalStore.complete(goal.id);

    // 写入意识流（工作反思）
    if (mind) {
      mind.addThought({
        content: `[工作] ${goal.title}：${summary.slice(0, 120)}`,
        kind: 'work',
        action: 'work',
        tick: timeContext?.tickCount,
      });
    }

    return { summary, progress, done: progress >= 1, workDir };
  }
}
