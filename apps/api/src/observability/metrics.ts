import client from "prom-client";

export function createMetrics() {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  // RED metrics: Rate and Errors come from the counter, Duration from the histogram.
  const httpDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request latency",
    labelNames: ["method", "route", "status"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const remindersSent = new client.Counter({
    name: "reminders_processed_total",
    help: "Reminder deliveries by outcome",
    labelNames: ["outcome"],
    registers: [registry],
  });
  const queueDepth = new client.Gauge({
    name: "reminder_queue_jobs",
    help: "BullMQ reminder jobs by state",
    labelNames: ["state"],
    registers: [registry],
  });
  const dispensed = new client.Counter({
    name: "inventory_units_dispensed_total",
    help: "Units dispensed via FEFO allocation",
    registers: [registry],
  });
  return { registry, httpDuration, remindersSent, queueDepth, dispensed };
}
export type Metrics = ReturnType<typeof createMetrics>;
