/** Freeze the interpreter's scheduled work while human approval is pending. */
import type { Scheduler } from "effect";

/** Programs in this process whose work is held while they wait for a person. */
const parked = { count: 0 };
export const parkedPrograms = () => parked.count;

/** Delegate normal scheduling and yielding to Effect; hold only this program's tasks when parked. */
export function programScheduler(parent: Scheduler.Scheduler) {
  let paused = false;
  const held: Array<() => void> = [];
  const scheduler: Scheduler.Scheduler = {
    executionMode: parent.executionMode,
    shouldYield: (fiber) => paused || parent.shouldYield(fiber),
    makeDispatcher: () => {
      const dispatcher = parent.makeDispatcher();
      const scheduleTask = (task: () => void, priority: number) =>
        dispatcher.scheduleTask(() => {
          if (paused) held.push(() => scheduleTask(task, priority));
          else task();
        }, priority);
      return {
        scheduleTask,
        flush: () => {
          if (!paused) dispatcher.flush();
        },
      };
    },
  };
  return {
    scheduler,
    pause: () => {
      if (!paused) parked.count += 1;
      paused = true;
    },
    resume: () => {
      if (paused) parked.count -= 1;
      paused = false;
      for (const schedule of held.splice(0)) schedule();
    },
  };
}
