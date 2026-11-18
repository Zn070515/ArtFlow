function labels(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",");
}

interface Timer {
  count: number;
  sum: number;
}

/**
 * Minimal Prometheus text exposition. It deliberately has no dependency: the
 * operational questions are request rate, status mix, latency, rate limiting,
 * process memory and uptime.
 */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly timers = new Map<string, Timer>();
  private readonly startedAt = Date.now();

  inc(name: string, values: Readonly<Record<string, string>> = {}, amount = 1): void {
    const key = `${name}|${labels(values)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }

  observe(name: string, values: Readonly<Record<string, string>>, seconds: number): void {
    const key = `${name}|${labels(values)}`;
    const current = this.timers.get(key) ?? { count: 0, sum: 0 };
    current.count += 1;
    current.sum += seconds;
    this.timers.set(key, current);
  }

  render(): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) {
      const [name, labelText] = key.split("|", 2);
      lines.push(labelText === undefined || labelText === "" ? `${name} ${value}` : `${name}{${labelText}} ${value}`);
    }
    for (const [key, timer] of this.timers) {
      const [name, labelText] = key.split("|", 2);
      const suffix = labelText === undefined || labelText === "" ? "" : `{${labelText}}`;
      lines.push(`${name}_count${suffix} ${timer.count}`);
      lines.push(`${name}_sum${suffix} ${timer.sum}`);
    }
    const memory = process.memoryUsage();
    lines.push(`artflow_process_resident_memory_bytes ${memory.rss}`);
    lines.push(`artflow_process_heap_used_bytes ${memory.heapUsed}`);
    lines.push(`artflow_process_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`);
    return `${lines.join("\n")}\n`;
  }
}
