/**
 * OpenTelemetry bootstrap. Loaded with `node --import ./dist/tracing.js` (or via the
 * OTEL_EXPORTER_OTLP_ENDPOINT check in server.ts) BEFORE express/pg are imported so
 * auto-instrumentation can patch them. Exports OTLP to Jaeger locally, or to Grafana
 * Cloud's free tier in production; disabled entirely when no endpoint is configured.
 */
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { NodeSDK } from "@opentelemetry/sdk-node";

export function startTracing(): NodeSDK | null {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "vetledger-api",
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false }, // noisy, low value
      }),
    ],
  });
  sdk.start();
  return sdk;
}
