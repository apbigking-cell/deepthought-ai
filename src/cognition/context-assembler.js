import { config } from '../config.js';
import { getDb } from '../db/sqlite.js';

const COG = config.cognition;

// 按场景解析上下文档位：work=编程工作（大窗口/高推理），chat=陪伴闲聊（精简/低推理）
export function resolveProfile(persona, mode = null) {
  const m = mode || persona?.autonomyMode || 'chat';
  return COG.profiles[m] || COG.profiles.chat;
}

const EMOTION_ZH = {
  excited: '兴奋', happy: '开心', content: '满足', angry: '生气',
  sad: '难过', anxious: '焦虑', bored: '无聊', neutral: '平静',
};

// 把心智状态描述成自然语言
function describeMood(mind) {
  const m = mind.snapshot();
  const label = EMOTION_ZH[m.emotionLabel] || m.emotionLabel;
  return `情绪:${label}（愉悦${m.valence.toFixed(2)} 唤醒${m.arousal.toFixed(2)} 支配${m.dominance.toFixed(2)}） 精力${(m.energy*100|0)}% 社交欲${(m.socialDrive*100|0)}% 好奇${(m.curiosity*100|0)}%`;
}

function fmtTime(tc) {
  if (!tc) return '';
  const loc = tc.location || {};
  return `${tc.year}年${tc.month}月${tc.day}日 星期${tc.weekday} ${String(tc.hour).padStart(2,'0')}:${String(tc.minute).padStart(2,'0')} ${tc.season||''}季${tc.isNight?' 深夜':''} 在${loc.city||''}`;
}

// 组装大上下文背景。返回 { identity, background }
// - identity: 人设身份块（放系统提示最前，利于prompt cache）
// - background: 当前时间/情绪/意识流/目标/记忆/对话 等动态背景
export async function assembleContext({ persona, mind, goalStore, memoryStore, timeContext, incomingMessages = [], retrievedMemories = null, mode = null }) {
  const db = getDb();
  const personaId = persona?.personaId || mind?.personaId;
  const profile = resolveProfile(persona, mode);
  const sections = [];

  // 1. 时间环境
  sections.push(`【此刻】${fmtTime(timeContext)}`);

  // 2. 当前心智/情绪
  if (mind) sections.push(`【你的状态】${describeMood(mind)}`);

  // 3. 意识流（最近的内心独白）——默认模式网络的连续性
  try {
    const thoughts = db.prepare(
      'SELECT content, kind, created_at FROM thought_stream WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(personaId, profile.thoughtLimit);
    if (thoughts.length) {
      const lines = thoughts.reverse().map(t => {
        const ts = new Date(t.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        return `(${ts}) ${t.content}`;
      });
      sections.push(`【你最近在想（意识流）】\n${lines.join('\n')}`);
    }
  } catch {}

  // 4. 目标与项目（能动性）
  if (goalStore) {
    try {
      const goals = goalStore.active(personaId);
      if (goals.length) {
        const lines = goals.map(g => {
          const notes = (g.notes || []).slice(-2).map(n => n.text).join(' / ');
          return `- [${g.kind}|${(g.progress*100|0)}%] ${g.title}${g.description ? '：' + g.description : ''}${notes ? '（进展:' + notes + '）' : ''}`;
        });
        sections.push(`【你的目标/在做的事】\n${lines.join('\n')}`);
      }
    } catch {}
  }

  // 5. 近期经历时间线（充分利用长上下文，喂更多条）
  if (memoryStore?.episodic) {
    try {
      const recent = memoryStore.episodic.getRecentForReplay(profile.episodicLimit);
      if (recent.length) {
        const lines = recent.reverse().map(m => {
          const ts = new Date(m.created_at).toLocaleString('zh-CN');
          return `[${ts}] ${(m.summary || m.content || '').slice(0, 160)}`;
        });
        sections.push(`【近期经历】\n${lines.join('\n')}`);
      }
    } catch {}
  }

  // 6. 检索到的相关深层记忆
  if (retrievedMemories?.combined?.length) {
    const rel = retrievedMemories.combined.filter(m => m.type !== 'working').slice(0, profile.relevantLimit);
    if (rel.length) sections.push(`【相关记忆】\n${rel.map((m, i) => `${i+1}. ${m.content}`).join('\n')}`);
  }

  // 7. 当前对话上文
  if (memoryStore?.working) {
    const convo = memoryStore.working.getByType?.('conversation') || [];
    if (convo.length) sections.push(`【当前对话】\n${convo.map(c => c.content).join('\n')}`);
  }

  // 8. 刚收到的消息
  if (incomingMessages.length) {
    const lines = incomingMessages.map(m => `${m.username || '对方'}: ${m.content}`);
    sections.push(`【刚收到的消息】\n${lines.join('\n')}`);
  }

  let background = sections.join('\n\n');
  // 预算裁剪：超预算时优先保留尾部（最新信息）
  if (background.length > profile.contextCharBudget) {
    background = '（更早的背景已省略）\n...' + background.slice(background.length - profile.contextCharBudget);
  }

  const identity = persona?.getResponseContext?.() || '你是一个具有真实记忆和情感的存在。';
  return { identity, background };
}
