export interface ScheduledTaskDefinition {
  id: string;
  schedule: string;
  prompt: string;
  title?: string;
  enabled?: boolean;
  metadata?: Record<string, string>;
}

export interface ScheduledTask extends ScheduledTaskDefinition {
  enabled: boolean;
}

export interface ScheduledTaskEvent {
  task: ScheduledTask;
  scheduledFor: Date;
  timestamp: number;
}

export interface SchedulerConfig {
  tickIntervalMs?: number;
  now?: () => Date;
}

export type SchedulerListener = (event: ScheduledTaskEvent) => void;

interface CronField {
  readonly wildcard: boolean;
  readonly values: ReadonlySet<number>;
}

interface CompiledTask {
  readonly task: ScheduledTask;
  readonly expression: CronExpression;
}

interface CronExpression {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

const DEFAULT_TICK_INTERVAL_MS = 30_000;
const MINUTE_ALIASES = new Map<string, number>();
const HOUR_ALIASES = new Map<string, number>();
const MONTH_ALIASES = new Map<string, number>([
  ['JAN', 1],
  ['FEB', 2],
  ['MAR', 3],
  ['APR', 4],
  ['MAY', 5],
  ['JUN', 6],
  ['JUL', 7],
  ['AUG', 8],
  ['SEP', 9],
  ['OCT', 10],
  ['NOV', 11],
  ['DEC', 12],
]);
const DAY_OF_WEEK_ALIASES = new Map<string, number>([
  ['SUN', 0],
  ['MON', 1],
  ['TUE', 2],
  ['WED', 3],
  ['THU', 4],
  ['FRI', 5],
  ['SAT', 6],
]);

export class Scheduler {
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;
  private readonly listeners = new Set<SchedulerListener>();
  private readonly tasks = new Map<string, CompiledTask>();
  private readonly lastTriggeredMinute = new Map<string, number>();

  private timer: NodeJS.Timeout | undefined;

  public constructor(config: SchedulerConfig = {}) {
    this.tickIntervalMs = config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.now = config.now ?? (() => new Date());
  }

  public start(): void {
    if (this.timer !== undefined) {
      return;
    }

    this.timer = setInterval(() => {
      this.checkDueTasks();
    }, this.tickIntervalMs);
    this.timer.unref();
    this.checkDueTasks();
  }

  public stop(): void {
    if (this.timer === undefined) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  public onTask(listener: SchedulerListener): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: SchedulerListener): void {
    this.listeners.delete(listener);
  }

  public addTask(definition: ScheduledTaskDefinition): ScheduledTask {
    const task = normalizeTask(definition);
    const compiled: CompiledTask = {
      task,
      expression: parseCronExpression(task.schedule),
    };

    this.tasks.set(task.id, compiled);

    if (!task.enabled) {
      this.lastTriggeredMinute.delete(task.id);
    }

    return task;
  }

  public replaceTasks(definitions: ScheduledTaskDefinition[]): ScheduledTask[] {
    this.tasks.clear();
    this.lastTriggeredMinute.clear();

    return definitions.map((definition) => this.addTask(definition));
  }

  public removeTask(taskId: string): boolean {
    this.lastTriggeredMinute.delete(taskId);
    return this.tasks.delete(taskId);
  }

  public getTasks(): ScheduledTask[] {
    return [...this.tasks.values()].map(({ task }) => ({ ...task }));
  }

  public checkDueTasks(referenceDate: Date = this.now()): ScheduledTaskEvent[] {
    const dueEvents: ScheduledTaskEvent[] = [];
    const scheduledFor = truncateToMinute(referenceDate);
    const minuteKey = scheduledFor.getTime();

    for (const { task, expression } of this.tasks.values()) {
      if (!task.enabled || !matchesCronExpression(expression, scheduledFor)) {
        continue;
      }

      if (this.lastTriggeredMinute.get(task.id) === minuteKey) {
        continue;
      }

      this.lastTriggeredMinute.set(task.id, minuteKey);

      const event: ScheduledTaskEvent = {
        task: { ...task },
        scheduledFor: new Date(minuteKey),
        timestamp: referenceDate.getTime(),
      };

      dueEvents.push(event);
      this.emit(event);
    }

    return dueEvents;
  }

  private emit(event: ScheduledTaskEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function normalizeTask(definition: ScheduledTaskDefinition): ScheduledTask {
  const id = definition.id.trim();
  const schedule = definition.schedule.trim();
  const prompt = definition.prompt.trim();

  if (id.length === 0) {
    throw new Error('Scheduled task id is required');
  }

  if (schedule.length === 0) {
    throw new Error(`Scheduled task "${id}" must define a schedule`);
  }

  if (prompt.length === 0) {
    throw new Error(`Scheduled task "${id}" must define a prompt`);
  }

  return {
    ...definition,
    id,
    schedule,
    prompt,
    enabled: definition.enabled ?? true,
  };
}

function parseCronExpression(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expression}": expected 5 fields`,
    );
  }

  const minute = fields[0];
  const hour = fields[1];
  const dayOfMonth = fields[2];
  const month = fields[3];
  const dayOfWeek = fields[4];

  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    throw new Error(`Invalid cron expression "${expression}"`);
  }

  return {
    minute: parseCronField(minute, 0, 59, MINUTE_ALIASES),
    hour: parseCronField(hour, 0, 23, HOUR_ALIASES),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31, MINUTE_ALIASES),
    month: parseCronField(month, 1, 12, MONTH_ALIASES),
    dayOfWeek: parseCronField(dayOfWeek, 0, 7, DAY_OF_WEEK_ALIASES, {
      normalize: (value) => (value === 7 ? 0 : value),
    }),
  };
}

function parseCronField(
  value: string,
  min: number,
  max: number,
  aliases: ReadonlyMap<string, number>,
  options: { normalize?: (value: number) => number } = {},
): CronField {
  if (value === '*') {
    return {
      wildcard: true,
      values: new Set<number>(),
    };
  }

  const resolvedValues = new Set<number>();
  const parts = value.split(',');

  for (const part of parts) {
    const trimmedPart = part.trim().toUpperCase();

    if (trimmedPart.length === 0) {
      throw new Error(`Invalid cron field "${value}"`);
    }

    const [rangePart, stepPart] = trimmedPart.split('/');

    if (rangePart === undefined) {
      throw new Error(`Invalid cron field "${value}"`);
    }

    const step =
      stepPart === undefined ? 1 : parseInteger(stepPart, min, max, aliases);

    if (step <= 0) {
      throw new Error(`Invalid cron step "${trimmedPart}"`);
    }

    if (rangePart === '*') {
      for (let current = min; current <= max; current += step) {
        resolvedValues.add(normalizeCronValue(current, options.normalize));
      }

      continue;
    }

    const [startPart, endPart] = rangePart.split('-');

    if (startPart === undefined) {
      throw new Error(`Invalid cron field "${value}"`);
    }

    const startValue = parseInteger(startPart, min, max, aliases);
    const endValue =
      endPart === undefined
        ? startValue
        : parseInteger(endPart, min, max, aliases);

    if (endValue < startValue) {
      throw new Error(`Invalid cron range "${trimmedPart}"`);
    }

    for (let current = startValue; current <= endValue; current += step) {
      resolvedValues.add(normalizeCronValue(current, options.normalize));
    }
  }

  return {
    wildcard: false,
    values: resolvedValues,
  };
}

function parseInteger(
  value: string,
  min: number,
  max: number,
  aliases: ReadonlyMap<string, number>,
): number {
  const aliasValue = aliases.get(value);
  const parsedValue =
    aliasValue ??
    (Number.isInteger(Number(value)) ? Number.parseInt(value, 10) : Number.NaN);

  if (!Number.isInteger(parsedValue) || parsedValue < min || parsedValue > max) {
    throw new Error(`Cron value "${value}" must be between ${min} and ${max}`);
  }

  return parsedValue;
}

function normalizeCronValue(
  value: number,
  normalize: ((value: number) => number) | undefined,
): number {
  return normalize === undefined ? value : normalize(value);
}

function matchesCronExpression(
  expression: CronExpression,
  referenceDate: Date,
): boolean {
  const minuteMatches = matchesCronField(
    expression.minute,
    referenceDate.getMinutes(),
  );
  const hourMatches = matchesCronField(expression.hour, referenceDate.getHours());
  const monthMatches = matchesCronField(
    expression.month,
    referenceDate.getMonth() + 1,
  );

  if (!minuteMatches || !hourMatches || !monthMatches) {
    return false;
  }

  const dayOfMonthMatches = matchesCronField(
    expression.dayOfMonth,
    referenceDate.getDate(),
  );
  const dayOfWeekMatches = matchesCronField(
    expression.dayOfWeek,
    referenceDate.getDay(),
  );

  return matchesDayFields(
    expression.dayOfMonth,
    expression.dayOfWeek,
    dayOfMonthMatches,
    dayOfWeekMatches,
  );
}

function matchesCronField(field: CronField, value: number): boolean {
  return field.wildcard || field.values.has(value);
}

function matchesDayFields(
  dayOfMonth: CronField,
  dayOfWeek: CronField,
  dayOfMonthMatches: boolean,
  dayOfWeekMatches: boolean,
): boolean {
  if (dayOfMonth.wildcard && dayOfWeek.wildcard) {
    return true;
  }

  if (dayOfMonth.wildcard) {
    return dayOfWeekMatches;
  }

  if (dayOfWeek.wildcard) {
    return dayOfMonthMatches;
  }

  return dayOfMonthMatches || dayOfWeekMatches;
}

function truncateToMinute(value: Date): Date {
  const truncated = new Date(value);
  truncated.setSeconds(0, 0);
  return truncated;
}
