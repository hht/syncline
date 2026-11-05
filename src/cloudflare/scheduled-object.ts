import { DurableObject } from 'cloudflare:workers';
import { Schedule } from './schedule.ts';

/** Base Durable Object managing alarms via a schedule table for internal chores and integrator callbacks. */
export abstract class ScheduledObject<Env> extends DurableObject<Env> {
  /** Schedule table manager for internal chores; integrators use schedule and unschedule. */
  protected readonly timetable: Schedule;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.timetable = new Schedule(ctx.storage);
  }

  /** Schedules an integrator callback to run no later than at epoch ms; name must not start with syncline:. */
  protected readonly schedule = (name: string, at: number) => this.timetable.own(name, at);

  protected readonly unschedule = (name: string) => this.timetable.disown(name);

  /** Invoked when an integrator scheduled task is due; subclasses may override. */
  protected scheduled: (name: string) => void | Promise<void> = () => undefined;
}
