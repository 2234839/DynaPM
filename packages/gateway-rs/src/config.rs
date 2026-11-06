//! DynaPM 配置类型与加载器（字段与 Bun 版 `src/config/types.ts` 对齐）
//!
//! Rust 版无法直接执行 `dynapm.config.ts`，采用等价 JSON 配置
//! `dynapm.config.json`（或 `DYNAPM_CONFIG` 指定路径），
//! 字段命名与 TS 版完全一致，便于同一套语义双实现对照。

use serde::Deserialize;
use std::collections::HashMap;

/// 健康检查类型
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum HealthCheckType {
    #[default]
    Tcp,
    Http,
    Command,
    None,
}

/// 健康检查配置
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthCheckConfig {
    /// 健康检查类型：tcp | http | command | none
    #[serde(rename = "type")]
    pub check_type: Option<HealthCheckType>,
    /// TCP 检查：端口号（默认从 base URL 提取）
    pub port: Option<u16>,
    /// HTTP 检查：URL（默认使用服务 base 地址）
    pub url: Option<String>,
    /// HTTP 检查：期望状态码
    pub expected_status: Option<u16>,
    /// 命令检查：bash 命令（退出码 0 表示健康）
    pub command: Option<String>,
    /// 超时时间（毫秒）
    pub timeout: Option<u64>,
}

/// 服务命令配置
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ServiceCommands {
    /// 启动命令（bash 通用方式）；配置了 startExec 时可不填
    pub start: String,
    /// 直接 fork/exec 启动的参数数组（如 ["bun", "server.ts"]），
    /// 跳过 bash 中间层，冷启动更快；配置后优先于 start
    pub start_exec: Option<Vec<String>>,
    /// 停止命令
    pub stop: Option<String>,
    /// 检查运行状态命令（退出码 0 = 运行中）
    pub check: Option<String>,
    /// 工作目录
    pub cwd: Option<String>,
    /// 环境变量
    pub env: Option<HashMap<String, String>>,
    /// startExec 直启时的日志文件（stdout/stderr 追加重定向；缺省为 /dev/null）
    pub log_file: Option<String>,
}

impl Default for ServiceCommands {
    fn default() -> Self {
        Self {
            start: String::new(),
            start_exec: None,
            stop: None,
            check: None,
            cwd: None,
            env: None,
            log_file: None,
        }
    }
}

/// 路由类型
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RouteType {
    Host,
    Port,
}

/// 路由配置
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteConfig {
    /// 路由类型：host | port
    #[serde(rename = "type")]
    pub route_type: RouteType,
    /// 路由值：网关端的 hostname 或端口号
    pub value: serde_json::Value,
    /// 目标后端地址：转发到的实际服务地址
    pub target: String,
}

/// 服务配置（用户输入形态：name/idleTimeout/startTimeout 可省略，loader 兜底）
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ServiceConfigInput {
    /// 服务标识（省略时取 services key）
    pub name: Option<String>,
    /// 服务地址
    pub base: Option<String>,
    /// 闲置超时（毫秒，默认 300000）
    pub idle_timeout: Option<u64>,
    /// 启动超时（毫秒，默认 30000）
    pub start_timeout: Option<u64>,
    /// 服务命令
    pub commands: Option<ServiceCommands>,
    /// 健康检查配置
    pub health_check: Option<HealthCheckConfig>,
    /// 纯代理模式：只做反向代理，不启动/停止服务
    pub proxy_only: Option<bool>,
    /// TCP 直通模式
    pub passthrough: Option<bool>,
    /// netns 模式：服务在零权限 user+net namespace 内运行，宿主机零端口占用
    /// （网关经 UDS 泵转发；与 passthrough 互斥）
    pub netns: Option<bool>,
    /// 常驻软预热：闲置回收时使用独立的 warmIdleTimeout 判定
    pub keep_warm: Option<bool>,
    /// 允许在该服务域名下访问 /_dynapm 管理面板与 API
    /// （默认拒绝：面板仅任于 adminApi.host 或本机回环地址）
    pub admin_panel: Option<bool>,
    /// keepWarm 服务的闲置回收阈值（毫秒，默认 30000）
    pub warm_idle_timeout: Option<u64>,
    /// Hostname 快捷映射
    pub host: Option<String>,
    /// 专属端口快捷映射
    pub port: Option<u16>,
    /// 复杂路由配置
    pub routes: Option<Vec<RouteConfig>>,
}

/// 管理 API 配置
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AdminApiConfig {
    /// 是否启用管理 API
    pub enabled: Option<bool>,
    /// 管理 API 独立端口
    pub port: Option<u16>,
    /// 专属访问域名：配置后面板/管理 API 仅在该 Host 下可达，
    /// 子服务域名下的 /_dynapm 路径回归透传（不再暴露管理面）
    pub host: Option<String>,
    /// API 认证令牌
    pub auth_token: Option<String>,
    /// 允许访问的 IP 白名单
    pub allowed_ips: Option<Vec<String>>,
}

/// 超时配置
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TimeoutsConfig {
    /// 等待服务停止完成的超时上限（毫秒，默认 30000）
    pub stop_wait_ms: Option<u64>,
    /// 停止命令执行超时（毫秒，默认 30000）
    pub stop_timeout_ms: Option<u64>,
    /// 代理请求超时（毫秒，后端无响应即 504，默认 30000）
    pub proxy_timeout_ms: Option<u64>,
    /// 链路停滞超时（毫秒，响应流/WS 桥无字节进展即断开，0 = 禁用，默认 120000）
    /// 独立于 proxyTimeoutMs：长轮询/SSE 等合法空闲长连接不被 30s 代理超时误杀
    pub stall_timeout_ms: Option<u64>,
    /// 同时冷启动的服务数上限（默认按 CPU 与内存双约束，保底 2 上限 8）
    pub start_concurrency: Option<usize>,
}

/// 日志配置
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LoggingConfig {
    /// 是否启用请求日志（每个请求响应记录）
    pub enable_request_log: Option<bool>,
    /// 是否启用 WebSocket 生命周期日志
    pub enable_websocket_log: Option<bool>,
    /// 是否启用错误日志
    pub enable_error_log: Option<bool>,
}

/// DynaPM 配置文件（用户输入形态）
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DynaPMConfigInput {
    /// 监听端口（默认 3000）
    pub port: Option<u16>,
    /// 监听主机（默认 127.0.0.1）
    pub host: Option<String>,
    /// 服务映射：hostname -> 服务配置
    pub services: Option<HashMap<String, ServiceConfigInput>>,
    /// 管理 API 配置
    pub admin_api: Option<AdminApiConfig>,
    /// 超时配置
    pub timeouts: Option<TimeoutsConfig>,
    /// 日志配置
    pub logging: Option<LoggingConfig>,
}

/// 规范化后的服务配置
#[derive(Debug, Clone, PartialEq)]
pub struct ServiceConfig {
    /// 服务标识
    pub name: String,
    /// 服务地址
    pub base: String,
    /// 闲置超时（毫秒）
    pub idle_timeout: u64,
    /// 启动超时（毫秒）
    pub start_timeout: u64,
    /// 服务命令
    pub commands: ServiceCommands,
    /// 健康检查配置
    pub health_check: Option<HealthCheckConfig>,
    /// 纯代理模式
    pub proxy_only: bool,
    /// TCP 直通模式
    pub passthrough: bool,
    /// netns 模式（宿主机零端口占用，UDS 泵转发）
    pub netns: bool,
    /// 常驻软预热
    pub keep_warm: bool,
    /// 允许该服务域名下访问管理面板
    pub admin_panel: bool,
    /// keepWarm 闲置回收阈值（毫秒）
    pub warm_idle_timeout: u64,
}

/// 规范化后的路由
#[derive(Debug, Clone, PartialEq)]
pub enum RouteValue {
    /// hostname 路由
    Host(String),
    /// 端口路由
    Port(u16),
}

/// 规范化后的路由映射
#[derive(Debug, Clone, PartialEq)]
pub struct RouteConfigResolved {
    /// 路由入口
    pub route: RouteValue,
    /// 目标后端地址
    pub target: String,
    /// 解析出的目标主机
    pub target_host: String,
    /// 解析出的目标端口
    pub target_port: u16,
    /// 目标是否为 https（代理转发用）
    pub target_https: bool,
}

/// 规范化后的全局配置
#[derive(Debug, Clone)]
pub struct DynaPMConfig {
    /// 监听端口
    pub port: u16,
    /// 监听主机
    pub host: String,
    /// 规范化后的服务列表（按配置顺序，admin 详情/文档用）
    #[allow(dead_code)]
    pub services: Vec<ServiceConfig>,
    /// 解析后的路由映射（服务配置 + 目标解析结果）
    pub resolved_routes: Vec<(ServiceConfig, RouteConfigResolved)>,
    /// 管理 API 配置
    pub admin_api: Option<AdminApiConfig>,
    /// 等待服务停止完成的超时上限（毫秒）
    pub stop_wait_ms: u64,
    /// 停止命令执行超时（毫秒）
    pub stop_timeout_ms: u64,
    /// 代理请求超时（毫秒）
    pub proxy_timeout_ms: u64,
    /// 链路停滞超时（毫秒，0 = 禁用）
    pub stall_timeout_ms: u64,
    /// 同时冷启动的服务数上限（默认按 CPU 与内存双约束，保底 2 上限 8）
    pub start_concurrency: usize,
    /// 请求日志开关
    pub enable_request_log: bool,
    /// WebSocket 日志开关
    pub enable_websocket_log: bool,
}

/// 默认闲置超时（毫秒，与 Bun 版 loader 对齐）
pub const DEFAULT_IDLE_TIMEOUT_MS: u64 = 300_000;
/// 默认启动超时（毫秒）
pub const DEFAULT_START_TIMEOUT_MS: u64 = 30_000;
/// keepWarm 默认闲置回收阈值（毫秒）
pub const DEFAULT_WARM_IDLE_TIMEOUT_MS: u64 = 30_000;

/**
 * 读取本进程内存上限（MB）：cgroup v2 memory.max 与 /proc/meminfo MemTotal 取小。
 * 容器化部署时 cgroup 限额才是真实可用内存；读不到返回 0（视为不限）。
 */
fn system_memory_limit_mb() -> u64 {
    let mut limit = read_meminfo_total_mb().unwrap_or(u64::MAX);
    if let Ok(text) = std::fs::read_to_string("/sys/fs/cgroup/memory.max") {
        // cgroup v2："max" 表示不限
        if let Ok(v) = text.trim().parse::<u64>() {
            limit = limit.min(v / 1024 / 1024);
        }
    }
    if limit == u64::MAX {
        0
    } else {
        limit
    }
}

/** 从 /proc/meminfo 读 MemTotal（MB） */
fn read_meminfo_total_mb() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            // 单位 kB（实为 KiB）
            return rest.trim().split_whitespace().next()?.parse::<u64>().ok().map(|kb| kb / 1024);
        }
    }
    None
}

/**
 * 默认冷启动并发上限：按系统实际情况双约束——
 * CPU 上限 = 核数（冷启动主要是进程/IO 等待，不必减一）；
 * 内存上限 = 总内存 / 512MB（单次冷启动预算）；
 * 保底 2：单槽位会被一个故障服务的重试循环长期饿死（配合失败冷却双保险），
 * 上限 8 防止大机冷启动风暴。timeouts.startConcurrency 可显式覆盖。
 */
fn default_start_concurrency() -> usize {
    let cpu = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .max(2);
    let mem_mb = system_memory_limit_mb();
    let mem_bound: usize = if mem_mb == 0 { 8 } else { (mem_mb / 512).max(1) as usize };
    cpu.min(mem_bound).clamp(2, 8)
}

/// 从 JSON 文本加载并规范化配置
///
/// name 缺省取 services key；idleTimeout/startTimeout 缺省用默认值；
/// host/port 快捷字段展开为 routes；与 Bun 版 loader 语义一致。
pub fn load_config_from_str(content: &str) -> Result<DynaPMConfig, String> {
    let input: DynaPMConfigInput =
        serde_json::from_str(content).map_err(|e| format!("配置解析失败: {e}"))?;
    resolve_config(input)
}

/// 用户级默认配置路径（~/.config/dynapm/dynapm.config.json），目录不存在则创建。
/// sudo 环境下 HOME=/root 会指错人：优先用 SUDO_USER 的真实 home（getent 解析）
fn user_config_path() -> std::path::PathBuf {
    let home = std::env::var("SUDO_USER")
        .ok()
        .filter(|u| !u.is_empty())
        .and_then(|u| {
            let out = std::process::Command::new("getent")
                .arg("passwd")
                .arg(&u)
                .output()
                .ok()?;
            let line = String::from_utf8_lossy(&out.stdout);
            let field = line.split(':').nth(5)?.to_string();
            if field.is_empty() { None } else { Some(field) }
        })
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".to_string());
    let dir = std::path::Path::new(&home).join(".config/dynapm");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("dynapm.config.json")
}

/// 配置文件路径解析：DYNAPM_CONFIG 显式指定 > 当前目录 dynapm.config.json > 用户级默认。
/// 用户级文件不存在时自动创建最小骨架（dev 用户开箱即用，无需手写配置）
pub fn config_path() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("DYNAPM_CONFIG") {
        return std::path::PathBuf::from(p);
    }
    let local = std::path::PathBuf::from("dynapm.config.json");
    if local.exists() {
        return local;
    }
    let user = user_config_path();
    if !user.exists() {
        // 骨架默认带 adminApi.host：dev 用户面板固定用 http://dynapm.localhost 访问
        let skeleton = serde_json::json!({
            "host": "127.0.0.1",
            "adminApi": { "host": "dynapm.localhost" },
            "services": {}
        });
        let _ = std::fs::write(&user, serde_json::to_string_pretty(&skeleton).unwrap());
    }
    user
}

/// 从文件加载配置（路径解析见 [`config_path`]）
pub fn load_config() -> Result<DynaPMConfig, String> {
    let path = config_path();
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取配置 {} 失败: {e}", path.display()))?;
    load_config_from_str(&content)
}

/// 解析 http(s) URL 为 (host, port, https)
pub fn parse_base_url(url: &str) -> Result<(String, u16, bool), String> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| format!("URL 缺少协议: {url}"))?;
    let https = match scheme {
        "http" => false,
        "https" => true,
        _ => return Err(format!("不支持的协议: {scheme}")),
    };
    let host_port = rest.split('/').next().unwrap_or(rest);
    let default_port: u16 = if https { 443 } else { 80 };
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) => (
            h.to_string(),
            p.parse::<u16>().map_err(|_| format!("端口非法: {host_port}"))?,
        ),
        None => (host_port.to_string(), default_port),
    };
    if host.is_empty() {
        return Err(format!("URL 缺少主机: {url}"));
    }
    Ok((host, port, https))
}

fn resolve_config(input: DynaPMConfigInput) -> Result<DynaPMConfig, String> {
    let timeouts = input.timeouts.unwrap_or_default();
    let logging = input.logging.unwrap_or_default();

    let mut services = Vec::new();
    for (key, sc) in input.services.unwrap_or_default() {
        let name = sc.name.clone().unwrap_or(key);
        let base = sc.base.clone().unwrap_or_default();
        let commands = sc.commands.clone().unwrap_or_default();
        let keep_warm = sc.keep_warm.unwrap_or(false);
        let admin_panel = sc.admin_panel.unwrap_or(false);

        // 快捷字段 host/port + 显式 routes 统一展开
        let mut routes: Vec<RouteConfig> = sc.routes.clone().unwrap_or_default();
        if let Some(h) = &sc.host {
            routes.push(RouteConfig {
                route_type: RouteType::Host,
                value: serde_json::Value::String(h.clone()),
                target: base.clone(),
            });
        }
        if let Some(p) = sc.port {
            routes.push(RouteConfig {
                route_type: RouteType::Port,
                value: serde_json::Value::from(p),
                target: base.clone(),
            });
        }
        if routes.is_empty() {
            return Err(format!("[{name}] 没有配置路由"));
        }

        let service = ServiceConfig {
            name,
            base,
            idle_timeout: sc.idle_timeout.unwrap_or(DEFAULT_IDLE_TIMEOUT_MS),
            start_timeout: sc.start_timeout.unwrap_or(DEFAULT_START_TIMEOUT_MS),
            commands,
            health_check: sc.health_check.clone(),
            proxy_only: sc.proxy_only.unwrap_or(false),
            passthrough: sc.passthrough.unwrap_or(false),
            netns: sc.netns.unwrap_or(false),
            keep_warm,
            admin_panel,
            warm_idle_timeout: sc
                .warm_idle_timeout
                .unwrap_or(DEFAULT_WARM_IDLE_TIMEOUT_MS),
        };
        if service.netns && service.passthrough {
            return Err(format!(
                "[{}] netns 与 passthrough 互斥：TCP 直通需要宿主机端口，netns 模式不占用端口",
                service.name
            ));
        }
        if service.netns && service.proxy_only {
            return Err(format!(
                "[{}] netns 模式需要启动命令（由网关拉起进 namespace），不支持 proxyOnly",
                service.name
            ));
        }
        services.push((service.name.clone(), service, routes));
    }

    // 展开路由并解析目标地址
    let mut resolved_routes = Vec::new();
    for (_, service, routes) in &services {
        for r in routes {
            let (target_host, target_port, target_https) = parse_base_url(&r.target)?;
            let route = match r.route_type {
                RouteType::Host => RouteValue::Host(match &r.value {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                }),
                RouteType::Port => RouteValue::Port(r.value.as_u64().unwrap_or_default() as u16),
            };
            let resolved = RouteConfigResolved {
                route,
                target: r.target.clone(),
                target_host,
                target_port,
                target_https,
            };
            resolved_routes.push((service.clone(), resolved));        }
    }

    Ok(DynaPMConfig {
        // 默认 80：子域名免端口号是 dev 体验首选；未显式配置时无权限绑定会自动回退冷门端口
        port: input.port.unwrap_or(80),
        host: input.host.clone().unwrap_or_else(|| "127.0.0.1".to_string()),
        services: services.iter().map(|(_, s, _)| s.clone()).collect(),
        resolved_routes,
        admin_api: input.admin_api,
        stop_wait_ms: timeouts.stop_wait_ms.unwrap_or(30_000),
        stop_timeout_ms: timeouts.stop_timeout_ms.unwrap_or(30_000),
        proxy_timeout_ms: timeouts.proxy_timeout_ms.unwrap_or(30_000),
        stall_timeout_ms: timeouts.stall_timeout_ms.unwrap_or(120_000),
        start_concurrency: timeouts
            .start_concurrency
            .unwrap_or_else(default_start_concurrency),
        enable_request_log: logging.enable_request_log.unwrap_or(false),
        enable_websocket_log: logging.enable_websocket_log.unwrap_or(false),
    })
}
