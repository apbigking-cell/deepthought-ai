// 安全数学计算器
export const calculatorDef = {
  name: 'calculator',
  description: 'Evaluate a mathematical expression. Supports + - * / ** () and basic math functions.',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Math expression, e.g. "2 + 3 * 4"' },
    },
    required: ['expression'],
  },
};

export async function calculatorHandler(args) {
  const expr = args.expression || '';
  // 安全过滤：只允许数学表达式字符
  if (!/^[\d\s+\-*/().,**\s%Math.sqrtMath.powMath.absMath.floorMath.ceil]+$/.test(expr)) {
    throw new Error('Invalid expression: only math operations allowed');
  }
  // 安全eval（限制在Math环境下）
  const result = Function('Math', `"use strict"; return (${expr})`)(Math);
  return `${expr} = ${Number(result.toFixed(10))}`;
}
