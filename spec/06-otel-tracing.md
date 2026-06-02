# GAP-59: OpenTelemetry 链路追踪增强

**优先级**: P2
**状态**: ✅ 已实现

## 概述

在现有的 `Telemetry` 单例和 `MetricsCollector` 基础上，增加自动 instrumentation、
多 exporter 支持和 trace context 传播能力。

## 设计

### 1. 自动 Instrumentation

通过 `@opentelemetry/instrumentation` 注册自动探针：

```ts
registerInstrumentations({
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => {
        if (req.url === '/health' || req.url === '/metrics') return true
        return false
      },
    }),
    new FastifyInstrumentation(),
  ],
})
```

- `HttpInstrumentation` — HTTP 请求/响应自动包裹 span，传递 W3C TraceContext
- `FastifyInstrumentation` — Fastify 路由层次自动追踪
- 健康检查和指标端点自动忽略，避免噪音

### 2. 多 Exporter 支持

`TelemetryExportConfig` 支持多个导出目标：

| 字段 | 环境变量 | 说明 |
|------|----------|------|
| `otlpGrpcEndpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP gRPC (默认 http://localhost:4317) |
| `otlpHttpEndpoint` | `OTEL_EXPORTER_OTLP_HTTP_ENDPOINT` | OTLP HTTP |
| `jaegerEndpoint` | `OTEL_EXPORTER_JAEGER_ENDPOINT` | Jaeger Collector (OTLP HTTP) |
| `zipkinEndpoint` | — | Zipkin Collector (OTLP HTTP) |

实现通过 `SimpleSpanProcessor` + 额外 trace exporter 并行导出。

### 3. 初始化流程

```ts
// 方式一：单独注册 + 初始化
telemetry.registerInstrumentations()
await telemetry.init('my-service', 'http://otel-collector:4317')

// 方式二：一步到位
await telemetry.initWithInstrumentations('my-service', 'http://otel-collector:4317')
```

### 4. API 变更

- `Telemetry.registerInstrumentations()` — 注册自动探针（必须在 init 前调用）
- `Telemetry.initWithInstrumentations()` — 注册 + 初始化快捷方法
- `TelemetryExportConfig` — 多导出端点的配置接口

### 5. 依赖

新增 npm 依赖：
- `@opentelemetry/instrumentation@^0.218.0`
- `@opentelemetry/instrumentation-http@^0.218.0`
- `@opentelemetry/instrumentation-fastify@^0.57.0`
- `@opentelemetry/exporter-trace-otlp-http@^0.218.0`

### 6. 测试覆盖

| 测试 | 说明 |
|------|------|
| GAP-59-01 | `initWithInstrumentations` 安全调用（无真实 Collector） |
| GAP-59-02 | 空端点不抛异常 |
| GAP-59-03 | `registerInstrumentations` 在 disabled 状态安全 |
| GAP-59-04 | `initWithInstrumentations` 整体不抛异常 |
| GAP-59-05 | `registerInstrumentations` 幂等 |
