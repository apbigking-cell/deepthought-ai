// 获取当前时间
export const timeDef = {
  name: 'get_current_time',
  description: 'Get the current date and time in the specified timezone.',
  parameters: {
    type: 'object',
    properties: {
      timezone: { type: 'string', description: 'Timezone, e.g. "Asia/Shanghai" (default) or "UTC"' },
    },
  },
};

export async function timeHandler(args) {
  const tz = args.timezone || 'Asia/Shanghai';
  const now = new Date();
  const opts = { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long', hour12: false };
  const formatted = new Intl.DateTimeFormat('zh-CN', opts).format(now);
  return {
    iso: now.toISOString(),
    formatted,
    timestamp: now.getTime(),
    timezone: tz,
  };
}
