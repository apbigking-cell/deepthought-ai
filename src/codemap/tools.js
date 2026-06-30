import { resolve, normalize } from 'node:path';
import { config } from '../config.js';
import { buildCodeMap } from './builder.js';
import { refreshProject } from './updater.js';

// codemap 工具集 —— 供工作型人格调用，从代码依赖图谱取上下文/构建/放大。
// 项目根从人格工作目录(沙箱)解析，project 参数可指向子目录，越界自动收敛回沙箱。
const WORKSPACE_ROOT = normalize(resolve(config.persona.workspaceRoot));

function resolveProject(context = {}, args = {}) {
  let base = context.workDir ? normalize(resolve(context.workDir)) : WORKSPACE_ROOT;
  if (!base.startsWith(WORKSPACE_ROOT)) base = WORKSPACE_ROOT;
  let proj = args.project ? normalize(resolve(base, args.project)) : base;
  if (!proj.startsWith(WORKSPACE_ROOT)) proj = base;
  return proj;
}

// 工厂：注入共享 CodeContextAgent，返回 [{ name, definition, handler }]
export function createCodemapTools({ contextAgent, config: cmCfg = {} } = {}) {
  const buildDef = {
    name: 'codemap_build',
    description: '为你工作目录中的项目构建/刷新"分层代码依赖图谱"(.codemap)。会静态分析源码生成文件依赖与方法级调用连线。改了很多代码后可手动刷新。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目子目录(相对工作目录)，默认整个工作目录' },
        full: { type: 'boolean', description: '是否全量重建(默认增量刷新)' },
      },
    },
  };
  const buildHandler = async (args = {}, context = {}) => {
    const proj = resolveProject(context, args);
    try {
      const stats = args.full
        ? buildCodeMap(proj, { config: cmCfg.builder })
        : refreshProject(proj, { config: cmCfg.builder });
      if (stats.fileCount != null) {
        return `已构建依赖图谱：${stats.fileCount} 文件 / ${stats.moduleCount} 模块 / ${stats.layers} 层。索引大小 ${stats.sizes.index}B。`;
      }
      return `已刷新依赖图谱：变更 ${stats.changed ?? 0} 个文件${stats.built ? '（首次全量构建）' : ''}。`;
    } catch (e) {
      return `构建失败: ${e.message}`;
    }
  };

  const queryDef = {
    name: 'codemap_query',
    description: '从代码依赖图谱获取上下文。给定 task 会逐层放大、智能挑选相关文件并返回紧凑的依赖关系+真实代码；不给 task 则返回项目总览。改代码前先用它了解相关依赖。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '你要做的事/要理解的功能(用于挑选相关代码)。留空则返回项目总览' },
        project: { type: 'string', description: '项目子目录(相对工作目录)' },
      },
    },
  };
  const queryHandler = async (args = {}, context = {}) => {
    const proj = resolveProject(context, args);
    try {
      if (args.task) {
        const r = await contextAgent.gatherContext(proj, args.task);
        return r.text + `\n\n(选中文件: ${r.files.join(', ') || '无'})`;
      }
      const ov = contextAgent.overview(proj);
      return `项目总览：${ov.counts.files} 文件 / ${ov.counts.modules} 模块 / ${ov.layers} 层\n\n${ov.indexMd.slice(0, 4000)}`;
    } catch (e) {
      return `查询失败: ${e.message}`;
    }
  };

  const zoomDef = {
    name: 'codemap_zoom',
    description: '放大查看依赖图谱中的某个节点（文件路径如 src/foo.js，或模块如 mod:utils），返回该节点的依赖区块与真实代码。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '节点ID：文件相对路径，或 mod:<模块名>' },
        project: { type: 'string', description: '项目子目录(相对工作目录)' },
      },
      required: ['node'],
    },
  };
  const zoomHandler = async (args = {}, context = {}) => {
    const proj = resolveProject(context, args);
    try {
      const r = contextAgent.zoom(proj, args.node);
      return r.text;
    } catch (e) {
      return `放大失败: ${e.message}`;
    }
  };

  return [
    { name: 'codemap_build', definition: buildDef, handler: buildHandler },
    { name: 'codemap_query', definition: queryDef, handler: queryHandler },
    { name: 'codemap_zoom', definition: zoomDef, handler: zoomHandler },
  ];
}
