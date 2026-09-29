/**
 * gateway-bun 的类型全部复用 Node 版 gateway 包（单一类型来源，避免漂移）
 */
export type {
  DynaPMConfig,
  ServiceConfig,
  ServiceState,
  ServiceCommands,
  RouteConfig,
  HealthCheckConfig,
  HealthCheckConfigInternal,
  AgentPoolConfig,
  AdminApiConfig,
  TimeoutsConfig,
  LoggingConfig,
} from '@dynapm/gateway/src/config/types.js';
