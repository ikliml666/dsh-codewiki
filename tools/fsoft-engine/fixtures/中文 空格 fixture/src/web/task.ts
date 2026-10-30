"""TypeScript fixture：验证 TS/JS 分析器在中文空格路径下也能出节点。"""

export interface TaskInput {
  id: string
  payload: string
}

export function normalize(input: TaskInput): TaskInput {
  return { id: input.id.trim(), payload: input.payload.trim() }
}

export class TaskQueue {
  private items: TaskInput[] = []

  push(input: TaskInput): number {
    this.items.push(normalize(input))
    return this.items.length
  }
}
