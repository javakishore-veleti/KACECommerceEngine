/**
 * Framework-free workflow + task contracts shared by every service impl.
 *
 *   Workflow.execute(ctx) -> ctx        (deterministic ordered composition of tasks)
 *   Task.execute(ctx)     -> ctx        (single-responsibility unit, mutates/augments ctx)
 */
export interface WorkflowContext {
  // Loosely typed on purpose — each workflow declares what it reads/writes via augmentation.
  [key: string]: unknown;
}

export interface Task<TCtx extends WorkflowContext = WorkflowContext> {
  readonly name: string;
  execute(ctx: TCtx): Promise<TCtx>;
}

export interface Workflow<TCtx extends WorkflowContext = WorkflowContext> {
  readonly name: string;
  execute(ctx: TCtx): Promise<TCtx>;
}

/**
 * Helper: run a list of tasks sequentially against a shared context.
 * Each task's output becomes the next task's input.
 */
export async function runTasks<T extends WorkflowContext>(tasks: Task<T>[], ctx: T): Promise<T> {
  let current = ctx;
  for (const t of tasks) {
    current = await t.execute(current);
  }
  return current;
}
