//! 核心网关：路由分发、按需启动状态机、流式代理、WS 桥接、闲置回收
//! （与 Bun 版 gateway.ts 行为对齐）

use crate::config::RouteValue;
use crate::logger;
use crate::state::{now_ms, wait_for_backend_ready, wait_status_leave, RouteMapping, ServiceRuntime, Status};
use axum::body::Body;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use bytes::Bytes;
use futures_util::Future;
use futures_util::{SinkExt, StreamExt};
use http::HeaderMap;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, Mutex as AsyncMutex};
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

/// WS 升级噢探提取器：请求带升级头时持 WebSocketUpgrade，否则为 None。
/// （axum 0.8 的 WebSocketUpgrade 未实现 OptionalFromRequestParts，
///   手写：升级头存在才委派官方提取器，不存在直接返回 None，永不拒绝请求）
pub struct MaybeWs(pub Option<WebSocketUpgrade>);

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for MaybeWs {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        let is_upgrade = parts
            .headers
            .get(axum::http::header::UPGRADE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
            && parts
                .headers
                .get(axum::http::header::CONNECTION)
                .and_then(|v| v.to_str().ok())
                .map(|v| v.to_ascii_lowercase().contains("upgrade"))
                .unwrap_or(false);
        if !is_upgrade {
            return Ok(MaybeWs(None));
        }
        Ok(MaybeWs(
            WebSocketUpgrade::from_request_parts(parts, state)
                .await
                .ok(),
        ))
    }
}

/// 请求体最大大小（10MB），防止 DoS 攻击（与 Bun 版一致）
pub const MAX_REQUEST_BODY_SIZE: usize = 10 * 1024 * 1024;
/// 闲置检查间隔（毫秒）
const IDLE_CHECK_INTERVAL_MS: u64 = 3000;

/// 不应转发的请求头（小写）
const SKIP_REQUEST_HEADERS: [&str; 4] = ["connection", "keep-alive", "content-length", "transfer-encoding"];
/// 不应转发的响应头（小写）
const SKIP_RESPONSE_HEADERS: [&str; 4] = ["connection", "transfer-encoding", "keep-alive", "content-length"];

/// 路由表快照：hostname/端口路由 + 服务运行时 + admin 面板域名。
/// 整体原子替换实现配置热更新，读路径 `table.load()` 无锁
pub struct RouteTable {
    /// admin 面板专属域名（adminApi.host，None = 不限定）
    pub admin_host: Option<String>,
    /// hostname 路由：hostname -> 路由映射
    pub hostname_routes: HashMap<String, Arc<RouteMapping>>,
    /// 端口路由：端口 -> 路由映射
    pub port_routes: HashMap<u16, Arc<RouteMapping>>,
    /// 按服务名索引的运行时
    pub runtimes: HashMap<String, Arc<ServiceRuntime>>,
}

/// 全局网关共享状态
/** 可热替换的进程级参数：超时/冷启动并发/admin token 均可运行期原地生效，无需重启网关 */
pub struct ProcessParams {
    /** 代理请求超时（毫秒） */
    pub proxy_timeout_ms: u64,
    /** 链路停滞超时（毫秒，0 = 禁用）：响应流/WS 桥无字节进展即断开 */
    pub stall_timeout_ms: u64,
    /** 等待服务停止完成的超时上限（毫秒） */
    pub stop_wait_ms: u64,
    /** 停止命令执行超时（毫秒） */
    pub stop_timeout_ms: u64,
    /** 冷启动并发上限（reload 仅在限额变化时替换信号量，进行中的排队不受影响） */
    pub start_concurrency: Arc<tokio::sync::Semaphore>,
    /** start_concurrency 当前限额（用于 reload 时比对是否需要重建信号量） */
    pub start_limit: usize,
    /** admin API 认证令牌 */
    pub admin_auth_token: Option<String>,
    /** admin API 跨域 Origin 白名单（精确匹配，空 = 禁止跨域） */
    pub admin_cors_origins: Arc<Vec<String>>,
    /** 主动回收：内存吃紧时驱逐无连接、非 keepWarm 的在跑服务给新启动腾地方 */
    pub aggressive_reclaim: bool,
    /** 主动回收触发线：MemAvailable 低于总内存的百分比（默认 15） */
    pub mem_reclaim_threshold_pct: u8,
}

pub struct Gateway {
    /// 路由表（ArcSwap 原子替换，热更新入口 reload()）
    table: arc_swap::ArcSwap<RouteTable>,
    /// 进程级参数（超时/并发/admin token）：ArcSwap 原子替换，reload() 热更新
    params: arc_swap::ArcSwap<ProcessParams>,
    /// 网关已知的配置文件 mtime（毫秒）：自身写入或已 reload 过的变更不算外部冲突
    pub(crate) config_mtime: std::sync::Mutex<u64>,
    /// 监听地址三元组（主端口/主host/admin端口）：socket 绑定于启动期，变更只能重启生效
    listener: Mutex<(u16, String, Option<u16>)>,
    /// 每服务启动互斥锁：并发请求同一服务时串行化启动（惰性创建，跨热更新保留——
    /// 锁只增不删，保证 reload 期间旧新代码路径对同一服务仍串行化）
    start_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// 端口路由监听任务句柄（热更新时按端口 diff 起停）
    port_listeners: Mutex<HashMap<u16, tokio::task::AbortHandle>>,
    /// 共享 HTTP 客户端（内部连接池 keep-alive，按目标自动复用）
    pub http_client: reqwest::Client,
    /// netns 服务专用 UDS HTTP 客户端（每服务一个连接器实例，见 uds_clients）
    pub uds_clients: Mutex<HashMap<String, crate::netns::UdsClient>>,
    /// 服务生命周期事件广播（admin SSE 用）
    pub events: broadcast::Sender<String>,
    /// 服务列表变更代数：任何启动/停止/关停事件自增，面板用游标避免无效全量拉取与重渲染
    pub epoch: std::sync::atomic::AtomicU64,
}

impl Gateway {
    /// 根据规范化配置构建网关
    pub fn new(
        routes: Vec<(Arc<ServiceRuntime>, crate::config::RouteConfigResolved)>,
        proxy_timeout_ms: u64,
        stall_timeout_ms: u64,
        stop_wait_ms: u64,
        stop_timeout_ms: u64,
        start_concurrency: usize,
        admin_auth_token: Option<String>,
        admin_host: Option<String>,
        admin_cors_origins: Vec<String>,
    ) -> Arc<Self> {
        let mut hostname_routes = HashMap::new();
        let mut port_routes = HashMap::new();
        let mut runtimes = HashMap::new();
        let mut start_locks = HashMap::new();

        for (rt, r) in routes {
            runtimes.insert(rt.config.name.clone(), rt.clone());
            start_locks.insert(rt.config.name.clone(), Arc::new(AsyncMutex::new(())));
            let mapping = Arc::new(RouteMapping {
                service: rt.clone(),
                target: r.target.clone(),
                target_host: r.target_host.clone(),
                target_port: r.target_port,
                target_https: r.target_https,
            });
            match r.route {
                RouteValue::Host(h) => {
                    hostname_routes.insert(h, mapping);
                }
                RouteValue::Port(p) => {
                    port_routes.insert(p, mapping);
                }
            }
        }

        let http_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            // 高并发下连接复用是代理吞吐的关键：空闲池太小会频繁建拆连接（TIME_WAIT 堆积 + 握手延迟）
            .pool_max_idle_per_host(512)
            .tcp_nodelay(true)
            .build()
            .expect("构建 HTTP 客户端失败");

        let (events, _) = broadcast::channel(256);

        Arc::new(Self {
            table: arc_swap::ArcSwap::from_pointee(RouteTable {
                admin_host,
                hostname_routes,
                port_routes,
                runtimes,
            }),
            params: arc_swap::ArcSwap::from_pointee(ProcessParams {
                proxy_timeout_ms,
                stall_timeout_ms,
                stop_wait_ms,
                stop_timeout_ms,
                start_limit: start_concurrency,
                start_concurrency: Arc::new(tokio::sync::Semaphore::new(start_concurrency.max(1))),
                admin_auth_token,
                admin_cors_origins: Arc::new(admin_cors_origins),
                aggressive_reclaim: false,
                mem_reclaim_threshold_pct: 15,
            }),
            config_mtime: std::sync::Mutex::new(0),
            listener: Mutex::new((0, String::new(), None)),
            start_locks: Mutex::new(start_locks),
            port_listeners: Mutex::new(HashMap::new()),
            http_client,
            uds_clients: Mutex::new(HashMap::new()),
            events,
            epoch: std::sync::atomic::AtomicU64::new(1),
        })
    }

    /// 进程级参数快照（ArcSwap 无锁读，请求路径零开销；Guard 可 Deref 到字段）
    pub fn params(&self) -> arc_swap::Guard<Arc<ProcessParams>> {
        self.params.load()
    }

    /// 记录启动期实际绑定的监听地址（main 绑定前调用，供配置变更时判定是否需重启）
    pub fn set_listener(&self, port: u16, host: String, admin_port: Option<u16>) {
        *self.listener.lock().unwrap() = (port, host, admin_port);
    }

    /// 新配置是否要求重新绑定 socket（主端口/host/admin端口变化）——唯一无法热更的项
    pub fn listener_changed(&self, cfg: &crate::config::DynaPMConfig) -> bool {
        let l = self.listener.lock().unwrap();
        *l != (
            cfg.port,
            cfg.host.clone(),
            cfg.admin_api.as_ref().and_then(|a| a.port),
        )
    }

    /// admin 面板在指定 Host 下是否可达：
    /// 默认拒绝；仅 adminApi.host 专属域名与本机回环（localhost/127.0.0.1/::1）放行，
    /// 服务域名一律透传给后端（专属域名已是面板的唯一入口，不再每个服务挂面板）
    pub fn host_allows_admin(&self, host: &str) -> bool {
        if matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1") {
            return true;
        }
        let table = self.table.load();
        table.admin_host.as_deref() == Some(host)
    }

    /// 发布服务生命周期事件（同时推进变更代数，面板据此感知需要刷新）
    pub fn publish_event(&self, msg: String) {
        self.epoch.fetch_add(1, Ordering::Relaxed);
        let _ = self.events.send(msg);
    }

    /// admin API 认证令牌（热替换参数的快照，返回拷贝避免持有 Guard）
    pub fn admin_auth_token(&self) -> Option<String> {
        self.params().admin_auth_token.clone()
    }

    /// admin API 跨域 Origin 白名单快照
    pub fn admin_cors_origins(&self) -> Vec<String> {
        (*self.params().admin_cors_origins).clone()
    }

    /// admin 面板专属域名快照
    pub fn admin_host(&self) -> Option<String> {
        self.table.load().admin_host.clone()
    }

    /// 全部运行时快照
    pub fn all_runtimes(&self) -> Vec<Arc<ServiceRuntime>> {
        self.table.load().runtimes.values().cloned().collect()
    }

    /// 按服务名查运行时
    pub fn runtime(&self, name: &str) -> Option<Arc<ServiceRuntime>> {
        self.table.load().runtimes.get(name).cloned()
    }

    /// 已注册服务数量
    pub fn service_count(&self) -> usize {
        self.table.load().runtimes.len()
    }

    /// hostname 路由快照（admin 面板收集域名用）
    pub fn hostname_routes_snapshot(&self) -> Vec<(String, Arc<RouteMapping>)> {
        self.table
            .load()
            .hostname_routes
            .iter()
            .map(|(h, m)| (h.clone(), Arc::clone(m)))
            .collect()
    }

    /// 端口路由快照（启动监听用）
    pub fn port_routes_snapshot(&self) -> Vec<(u16, Arc<RouteMapping>)> {
        self.table
            .load()
            .port_routes
            .iter()
            .map(|(p, m)| (*p, Arc::clone(m)))
            .collect()
    }

    /// 注册端口监听句柄（供启动流程使用）
    pub fn register_port_listener(&self, port: u16, handle: tokio::task::AbortHandle) {
        self.port_listeners.lock().unwrap().insert(port, handle);
    }

    /// 订阅服务生命周期事件（admin SSE）
    pub fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.events.subscribe()
    }

    /// admin API 主动启动：offline -> starting -> online
    pub async fn start_by_name(&self, rt: &Arc<ServiceRuntime>) -> Result<(), String> {
        let lock = self.start_lock(&rt.config.name);
        let _guard = lock.lock().await;
        if rt.status() == Status::Online || rt.config.proxy_only {
            return Ok(());
        }
        // 手动启动视为人工确认：清除失败冷却，立即重试
        rt.clear_start_failure();
        // 全局冷启动并发上限：排队等空位，防止小机被同时冷启动打爆（启动风暴）；
        // 信号量是 Arc 拷贝，reload 替换限额不影响在途排队
        let sem = Arc::clone(&self.params().start_concurrency);
        let _start_permit = sem.acquire().await;
        if rt.status() == Status::Online || rt.config.proxy_only {
            return Ok(());
        }
        rt.set_status(Status::Starting);
        let start_begun_ms = now_ms();
        let start_result = crate::state::start(&rt.config).await;
        if let Err(e) = start_result {
            rt.note_start_failure();
            rt.set_status(Status::Offline);
            return Err(e);
        }
        let start_pgid = start_result.unwrap_or_default();
        *rt.start_pgid.lock().unwrap() = if start_pgid > 0 { Some(start_pgid) } else { None };
        *rt.pid.lock().unwrap() = if start_pgid > 0 { Some(start_pgid) } else { None };
        rt.last_start_duration_ms
            .store((now_ms() - start_begun_ms) as i64, Ordering::Relaxed);
        rt.clear_start_failure();
        rt.set_status(Status::Online);
        *rt.start_time_ms.lock().unwrap() = Some(now_ms() as i64);
        rt.start_count.fetch_add(1, Ordering::Relaxed);
        self.publish_event(format!(r#"{{"type":"start","service":"{}"}}"#, rt.config.name));
        Ok(())
    }

    /// 优雅退出：停止全部在线服务
    pub async fn cleanup(&self) {
        for rt in self.all_runtimes() {
            if rt.status() == Status::Online {
                if let Err(e) = self.stop_service(rt).await {
                    logger::error("cleanup 停止服务失败", Some(&e));
                }
            }
        }
    }

    /// 配置热更新：路由表原子替换 + 端口监听 diff + 被移除/被修改服务停机。
    /// 同名且配置未变的服务复用现有运行时（在线服务不中断）；
    /// 超时参数等不可热更字段由调用方（admin put_config）判断后走自重启
    pub async fn reload(self: &Arc<Self>, cfg: &crate::config::DynaPMConfig) {
        let old = self.table.load_full();

        // 进程级参数热替换：超时/admin token 原地生效；冷启动并发限额变化时重建信号量
        // （在途排队持有旧信号量不受影响，新排队走新限额）
        {
            let p = self.params.load_full();
            let new_params = ProcessParams {
                proxy_timeout_ms: cfg.proxy_timeout_ms,
                stall_timeout_ms: cfg.stall_timeout_ms,
                stop_wait_ms: cfg.stop_wait_ms,
                stop_timeout_ms: cfg.stop_timeout_ms,
                start_limit: cfg.start_concurrency,
                start_concurrency: if p.start_limit == cfg.start_concurrency {
                    Arc::clone(&p.start_concurrency)
                } else {
                    Arc::new(tokio::sync::Semaphore::new(cfg.start_concurrency.max(1)))
                },
                admin_auth_token: cfg.admin_api.as_ref().and_then(|a| a.auth_token.clone()),
                admin_cors_origins: Arc::new(
                    cfg.admin_api
                        .as_ref()
                        .and_then(|a| a.cors_origins.clone())
                        .unwrap_or_default(),
                ),
                aggressive_reclaim: cfg.aggressive_reclaim,
                mem_reclaim_threshold_pct: cfg.mem_reclaim_threshold_pct,
            };
            self.params.store(Arc::new(new_params));
        }

        // 构建新运行时集合：配置未变的同名服务复用旧运行时
        let mut new_runtimes: HashMap<String, Arc<ServiceRuntime>> = HashMap::new();
        for (svc, resolved) in &cfg.resolved_routes {
            let rt = match old.runtimes.get(&svc.name) {
                Some(existing) if existing.config == *svc => Arc::clone(existing),
                _ => ServiceRuntime::new(svc.clone()),
            };
            new_runtimes.insert(svc.name.clone(), Arc::clone(&rt));
            let _ = resolved;
        }

        // 构建新路由表
        let mut hostname_routes = HashMap::new();
        let mut port_routes: HashMap<u16, Arc<RouteMapping>> = HashMap::new();
        for (svc, resolved) in &cfg.resolved_routes {
            let Some(rt) = new_runtimes.get(&svc.name) else { continue };
            let mapping = Arc::new(RouteMapping {
                service: Arc::clone(rt),
                target: resolved.target.clone(),
                target_host: resolved.target_host.clone(),
                target_port: resolved.target_port,
                target_https: resolved.target_https,
            });
            match &resolved.route {
                RouteValue::Host(h) => {
                    hostname_routes.insert(h.clone(), mapping);
                }
                RouteValue::Port(p) => {
                    port_routes.insert(*p, mapping);
                }
            }
        }
        self.table.store(Arc::new(RouteTable {
            admin_host: cfg.admin_api.as_ref().and_then(|a| a.host.clone()),
            hostname_routes,
            port_routes: port_routes.clone(),
            runtimes: new_runtimes.clone(),
        }));

        // 端口监听 diff：新增端口起监听，移除端口 abort
        {
            let mut listeners = self.port_listeners.lock().unwrap();
            let old_ports: Vec<u16> = listeners.keys().copied().collect();
            for port in old_ports {
                if !port_routes.contains_key(&port) {
                    if let Some(h) = listeners.remove(&port) {
                        h.abort();
                        logger::info(&format!("🛑 端口 {port} 监听已移除（配置热更新）"));
                    }
                }
            }
            for (port, mapping) in port_routes {
                if !listeners.contains_key(&port) {
                    let h = if mapping.service.config.passthrough {
                        self.start_passthrough_listener(port, mapping)
                    } else {
                        self.start_port_http_listener(port, mapping)
                    };
                    listeners.insert(port, h);
                }
            }
        }

        // 停掉被移除或被修改（配置变化导致运行时替换）的服务
        let to_stop: Vec<(String, Arc<ServiceRuntime>)> = old
            .runtimes
            .iter()
            .filter(|(name, old_rt)| {
                !new_runtimes
                    .get(*name)
                    .map(|r| Arc::ptr_eq(r, *old_rt))
                    .unwrap_or(false)
            })
            .filter(|(_, old_rt)| old_rt.status() != Status::Offline)
            .map(|(name, old_rt)| (name.clone(), Arc::clone(old_rt)))
            .collect();
        for (name, rt) in to_stop {
            logger::info(&format!("🔁 [{name}] 配置已变更/移除，停机旧实例（热更新）"));
            let gw = Arc::clone(self);
            tokio::spawn(async move {
                if let Err(e) = gw.stop_service(rt).await {
                    logger::error(&format!("❌ [{name}] 热更新停机失败"), Some(&e));
                }
            });
        }
        logger::info(&format!(
            "♻️ 配置热更新完成，当前 {} 个服务",
            new_runtimes.len()
        ));
    }

    /// 按 Host 头查找路由
    pub fn find_hostname_route(&self, hostname: &str) -> Option<Arc<RouteMapping>> {
        self.table.load().hostname_routes.get(hostname).cloned()
    }

    /** 读 /proc/meminfo：返回 (MemAvailable, MemTotal) 字节 */
    fn mem_available_total() -> Option<(u64, u64)> {
        let s = std::fs::read_to_string("/proc/meminfo").ok()?;
        let mut avail = None;
        let mut total = None;
        for line in s.lines() {
            if let Some(v) = line.strip_prefix("MemAvailable:") {
                avail = v.trim().trim_end_matches(" kB").parse::<u64>().ok().map(|k| k * 1024);
            } else if let Some(v) = line.strip_prefix("MemTotal:") {
                total = v.trim().trim_end_matches(" kB").parse::<u64>().ok().map(|k| k * 1024);
            }
        }
        Some((avail?, total?))
    }

    /**
     * 内存压力主动回收：MemAvailable 低于阈值时，驱逐「无活跃连接、非 keepWarm、
     * 非 starting」的在跑服务，剩余闲置时间（idleRemaining）最小者优先——
     * 最接近自然回收的先杀，语义等价于帮闲置回收提前收尾；
     * 正在被访问（活跃连接 > 0）或刚被唤醒的服务绝不会被杀
     */
    async fn reclaim_for_memory(&self, exclude: &str) {
        let Some((avail, total)) = Self::mem_available_total() else { return };
        let pct = self.params().mem_reclaim_threshold_pct as u64;
        if avail * 100 > total * pct {
            return;
        }
        logger::info(&format!(
            "🧹 内存吃紧（可用 {:.0}MB < {pct}%），主动回收无连接服务…",
            avail as f64 / 1024.0 / 1024.0
        ));
        // 候选：online、无连接、非 keepWarm、非 proxyOnly（无进程可杀）
        let mut victims: Vec<Arc<ServiceRuntime>> = self
            .all_runtimes()
            .into_iter()
            .filter(|rt| {
                rt.config.name != exclude
                    && rt.status() == Status::Online
                    && rt.active_connections.load(Ordering::Relaxed) == 0
                    && !rt.config.keep_warm
                    && !rt.config.proxy_only
            })
            .collect();
        // 剩余闲置时间最小者优先（最接近自然回收的先杀）
        victims.sort_by_key(|rt| {
            let threshold = if rt.config.keep_warm { rt.config.warm_idle_timeout } else { rt.config.idle_timeout };
            let elapsed = now_ms() as i64 - rt.last_access_ms.load(Ordering::Relaxed) as i64;
            (threshold as i64 - elapsed).max(0)
        });
        for rt in victims {
            // 逐个杀并观察内存恢复，够用即停
            if let Some((avail, total)) = Self::mem_available_total() {
                if avail * 100 > total * pct {
                    break;
                }
            }
            let name = rt.config.name.clone();
            logger::info(&format!("🧹 [{name}] 内存压力主动回收（闲置中、无连接）"));
            if let Err(e) = self.stop_service(rt).await {
                logger::error(&format!("❌ [{name}] 主动回收失败"), Some(&e));
            }
        }
    }

    /// 取（惰性创建）服务启动互斥锁
    fn start_lock(&self, name: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self.start_locks.lock().unwrap();
        locks
            .entry(name.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    /// 确保服务在线（供启动/等待路径共用）：每服务互斥串行化
    pub async fn ensure_service_online(&self, mapping: &Arc<RouteMapping>) -> Result<(), String> {
        let rt = &mapping.service;
        let cfg = &rt.config;
        if cfg.proxy_only || rt.status() == Status::Online {
            return Ok(());
        }
        if cfg.proxy_only || rt.status() == Status::Online {
            return Ok(());
        }
        let lock = self.start_lock(&cfg.name);
        // 持锁进入：并发请求会在锁上排队，前一个完成后后一个直接命中 online 短路
        let _guard = lock.lock().await;

        // 内存压力主动回收：低内存时驱逐「无连接、非 keepWarm」的在跑服务给新启动腾地方；
        // 牺牲者优先级 = 剩余闲置时间最小（最接近自然回收的先杀），正在访问的服务绝不会被杀
        if self.params().aggressive_reclaim {
            self.reclaim_for_memory(cfg.name.as_str()).await;
        }

        if cfg.proxy_only || rt.status() == Status::Online {
            return Ok(());
        }

        // 启动失败冷却：故障服务在冷却期内快速拒绝，不占用冷启动槽位也不执行启动命令
        // （否则一个起不来的服务会以 start_timeout 为周期无限重试，长期饿死其他服务的冷启动）
        let cooldown_left = rt.start_cooldown_remaining_ms();
        if cooldown_left > 0 {
            let streak = rt.start_fail_streak.load(Ordering::Relaxed);
            return Err(format!(
                "服务连续启动失败 {streak} 次，冷却中（剩余 {} 秒）",
                cooldown_left / 1000
            ));
        }

        // 全局冷启动并发上限（与 ensure_service_online 同策略）
        let sem = Arc::clone(&self.params().start_concurrency);
        let _start_permit = sem.acquire().await;
        if cfg.proxy_only || rt.status() == Status::Online {
            return Ok(());
        }

        rt.set_status(Status::Starting);
        // 冷启动前整组清理旧进程：bash/泵/服务进程同属一个 pgid（bash 为组长），
        // 只杀泵会让旧 netns 里的服务进程变成无人转发的孤儿（内存持续泄漏）
        let stale_pgid = *rt.start_pgid.lock().unwrap();
        if cfg.netns {
            if let Some(g) = stale_pgid {
                crate::executor::kill_process_group(g);
            }
            // 防御性清理旧进程组：网关重启内存态丢失（start_pgid 为 None）时靠 groupfile 兜底
            let groupfile = crate::netns::pump_group_path(&cfg.name);
            if let Ok(pgid) = std::fs::read_to_string(&groupfile) {
                if let Ok(g) = pgid.trim().parse::<u32>() {
                    crate::executor::kill_process_group(g);
                }
                let _ = std::fs::remove_file(&groupfile);
            }
        }
        let start_begun_ms = now_ms();
        let start_result = crate::state::start(cfg).await;
        if let Err(e) = start_result {
            rt.note_start_failure();
            rt.set_status(Status::Offline);
            *rt.last_start_error.lock().unwrap() = Some(e.clone());
            return Err(e);
        }
        let start_pgid = start_result.unwrap_or_default();
        *rt.start_pgid.lock().unwrap() = if start_pgid > 0 { Some(start_pgid) } else { None };
        *rt.pid.lock().unwrap() = if start_pgid > 0 { Some(start_pgid) } else { None };
        let ready = wait_for_backend_ready(cfg, &to_resolved(mapping)).await;
        if !ready {
            rt.note_start_failure();
            rt.set_status(Status::Offline);
            let err = format!("服务启动超时: 端口 {} 不可用", mapping.target);
            *rt.last_start_error.lock().unwrap() = Some(err.clone());
            return Err(err);
        }
        rt.last_start_duration_ms
            .store((now_ms() - start_begun_ms) as i64, Ordering::Relaxed);
        rt.clear_start_failure();
        rt.set_status(Status::Online);
        *rt.start_time_ms.lock().unwrap() = Some(now_ms() as i64);
        rt.start_count.fetch_add(1, Ordering::Relaxed);
        // netns 服务每次冷启动都会重建 netns + UDS 泵（新 socket inode），
        // 必须丢弃旧 UDS 客户端（其连接池里的长连接指向已死的旧泵），否则转发 502
        if cfg.netns {
            self.uds_clients.lock().unwrap().remove(&cfg.name);
        }
        self.publish_event(format!(
            r#"{{"type":"start","service":"{}"}}"#,
            rt.config.name
        ));
        Ok(())
    }

    /// 停止服务（状态机：online -> stopping -> offline）
    /// 与冷启动共用同一把 start 锁串行化：否则 stop 可能在冷启动的 docker start 与
    /// 就绪判定之间杀掉后端，ensure 随后把状态设为 Online（实际已死），
    /// 用户会先吃一次 502 才走「后端已死」自愈路径
    pub async fn stop_service(&self, rt: Arc<ServiceRuntime>) -> Result<(), String> {
        let lock = self.start_lock(&rt.config.name);
        let _guard = lock.lock().await;
        if rt.status() == Status::Offline {
            // Offline 短路仅在上游确实无人监听时成立：端口仍被占（进程残留、
            // 用户手动起的 dev server、网关重启后状态机归零）时 disable/stop 必须真杀
            if !crate::state::is_running(&rt.config, true).await {
                return Ok(());
            }
        }
        rt.set_status(Status::Stopping);
        rt.close_session();
        let result = crate::state::stop(&rt, self.params().stop_timeout_ms).await;
        rt.set_status(Status::Offline);
        self.publish_event(format!(r#"{{"type":"stop","service":"{}"}}"#, rt.config.name));
        result
    }

    /// 闲置检查器：每 3 秒扫描一次（与 Bun 版语义一致，keepWarm 用独立短阈值）
    pub fn start_idle_reaper(self: &Arc<Self>) {
        let gw = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(IDLE_CHECK_INTERVAL_MS));
            loop {
                ticker.tick().await;
                let runtimes: Vec<Arc<ServiceRuntime>> = {
                    gw.all_runtimes()
                };
                for rt in runtimes {
                    let cfg = &rt.config;
                    if cfg.proxy_only {
                        continue;
                    }
                    let idle_threshold = if cfg.keep_warm {
                        cfg.warm_idle_timeout
                    } else {
                        cfg.idle_timeout
                    };
                    // idleTimeout/warmIdleTimeout = 0 表示永不回收（长驻服务如 SSH 隧道）
                    if idle_threshold == 0 {
                        continue;
                    }
                    let now = now_ms();
                    if rt.status() == Status::Online
                        && rt.active_connections.load(Ordering::Relaxed) == 0
                        && now as i64 - rt.last_access_ms.load(Ordering::Relaxed)
                            > idle_threshold as i64
                    {
                        logger::info(&format!("🛌 [{}] 闲置超时，正在停止...", cfg.name));
                        let gw2 = Arc::clone(&gw);
                        let rt2 = Arc::clone(&rt);
                        tokio::spawn(async move {
                            // 复查：判定（上面 clone runtimes 时）与真正执行 stop 之间可能有新请求到达，
                            // 此时杀后端会把在飞请求打成 502；复查不满足 idle 则放弃本次回收
                            let still_idle = rt2.active_connections.load(Ordering::Relaxed) == 0
                                && now_ms() as i64 - rt2.last_access_ms.load(Ordering::Relaxed)
                                    > idle_threshold as i64;
                            if !still_idle {
                                logger::info(&format!("↩️ [{}] 回收前复查发现新请求，跳过本次闲置停止", rt2.config.name));
                                return;
                            }
                            if let Err(e) = gw2.stop_service(Arc::clone(&rt2)).await {
                                logger::error(&format!("❌ [{}] 停止失败", rt2.config.name), Some(&e));
                            }
                        });
                    }
                }
            }
        });
    }

    /// 点燃启动：在独立 task 中推进冷启动，与请求生命周期解耦。
    /// 客户端断开只会取消等待的请求 handler，不会取消启动本身——
    /// 否则启动推进到一半（Starting 状态 + 已拉起进程）被取消，服务永久卡死且进程成孤儿
    fn kick_start_detached(self: &Arc<Self>, mapping: Arc<RouteMapping>) {
        let gw = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(e) = gw.ensure_service_online(&mapping).await {
                logger::warn(&format!(
                    "⚠️ [{}] 后台冷启动失败: {}",
                    mapping.service.config.name, e
                ));
            }
        });
    }

    /// 等待启动结果：watch 状态机直到 Online / Offline（失败）/ 超时。
    /// 请求 handler 在这里等待被取消是安全的——启动 task 不受影响，后续请求直接短路命中
    async fn wait_online(&self, rt: &Arc<ServiceRuntime>) -> Result<(), String> {
        let mut rx = rt.subscribe();
        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(rt.config.start_timeout.saturating_add(2_000));
        loop {
            match rt.status() {
                Status::Online => return Ok(()),
                Status::Offline => {
                    let err = rt
                        .last_start_error
                        .lock()
                        .unwrap()
                        .clone()
                        .unwrap_or_else(|| "Service failed to start".to_string());
                    return Err(err);
                }
                _ => {}
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("服务启动超时".to_string());
            }
            // 200ms 轮询兑底 + 状态变化即返回（与 wait_status_leave 同风格）
            let _ = tokio::time::timeout(Duration::from_millis(200), rx.changed()).await;
        }
    }

    /// 按需启动状态机：starting 等待 / stopping 等待 / offline 启动，返回是否可代理
    async fn ensure_ready(self: &Arc<Self>, mapping: &Arc<RouteMapping>) -> Result<(), String> {
        let rt = &mapping.service;
        let cfg = &rt.config;
        match rt.status() {
            Status::Starting => {
                // 自愈：Starting 可能是之前某次启动被客户端断开取消留下的半途状态，
                // 补一次点燃（内部的启动锁 + Online 短路保证幂等），然后等结果
                self.kick_start_detached(Arc::clone(mapping));
                self.wait_online(rt).await
            }
            Status::Stopping => {
                logger::info(&format!("⏳ [{}] 等待服务停止完成...", cfg.name));
                if wait_status_leave(rt, Status::Stopping, self.params().stop_wait_ms).await {
                    if rt.status() == Status::Offline {
                        rt.set_status(Status::Starting);
                        self.kick_start_detached(Arc::clone(mapping));
                        self.wait_online(rt).await
                    } else {
                        Ok(())
                    }
                } else {
                    logger::error(&format!("❌ [{}] 等待服务停止超时", cfg.name), None);
                    Err("Service stopping timeout".to_string())
                }
            }
            Status::Offline => {
                logger::info(&format!("🚀 [{}] 启动服务...", cfg.name));
                // 先同步置 Starting 再点燃：否则后台任务尚未跑到 set_status(Starting) 时，
                // 下面的 wait_online 会读到 Offline 误判为「启动失败」直接 503（服务实际还在正常拉起）
                rt.set_status(Status::Starting);
                self.kick_start_detached(Arc::clone(mapping));
                self.wait_online(rt).await
            }
            Status::Online => Ok(()),
        }
    }

    /// 端口路由与 hostname 路由共用的请求处理核心
    pub async fn route_request(
        self: &Arc<Self>,
        mapping: Arc<RouteMapping>,
        method: http::Method,
        path_and_query: String,
        headers: HeaderMap,
        body: Body,
    ) -> axum::response::Response {
        let rt = &mapping.service;
        let cfg = &rt.config;
        rt.last_access_ms.store(now_ms() as i64, Ordering::Relaxed);

        // 413 预检：content-length 声明超限直接拒绝
        if let Some(len) = declared_content_length(&headers) {
            if len > MAX_REQUEST_BODY_SIZE {
                logger::warn(&format!(
                    "⚠️ [{}] 请求体超过 {MAX_REQUEST_BODY_SIZE} 字节，返回 413",
                    cfg.name
                ));
                return text_response(axum::http::StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large");
            }
        }

        // 彻底关停（paused）：拒绝代理与按需拉起，返回 503（区别于 stop：stop 后下次请求会自动拉起）
        if rt.paused.load(Ordering::Relaxed) {
            return text_response(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Service Disabled");
        }

        if let Err(e) = self.ensure_ready(&mapping).await {
            logger::warn(&format!("⚠️ 服务不可用: {}", e));
            // 浏览器导航请求（GET + Accept: text/html）返回可自动重试的唤醒等待页，
            // API/XHR/WS 保持 503 语义——「访问即启动」场景下用户感知是进度而非报错
            if is_browser_navigation(&method, &headers) {
                return cold_start_waiting_page(&cfg.name, &e);
            }
            return text_response(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Service Unavailable");
        }

        self.proxy_request(mapping, method, path_and_query, headers, body)
            .await
    }

    /// 代理转发核心：流式请求体到后端，流式响应体回客户端
    async fn proxy_request(
        self: &Arc<Self>,
        mapping: Arc<RouteMapping>,
        method: http::Method,
        path_and_query: String,
        headers: HeaderMap,
        body: Body,
    ) -> axum::response::Response {
        let rt = &mapping.service;
        let cfg = &rt.config;
        rt.last_access_ms.store(now_ms() as i64, Ordering::Relaxed);
        rt.active_connections.fetch_add(1, Ordering::Relaxed);
        struct ConnGuard(Arc<ServiceRuntime>);
        impl Drop for ConnGuard {
            fn drop(&mut self) {
                self.0.active_connections.fetch_sub(1, Ordering::Relaxed);
            }
        }
        let _guard = ConnGuard(Arc::clone(rt));
        let proxy_started_at = std::time::Instant::now();

        let scheme = if mapping.target_https { "https" } else { "http" };
        let url = format!("{}://{}:{}{}", scheme, mapping.target_host, mapping.target_port, path_and_query);

        // 构建代理请求头：剥离逐跳头，host 重写为目标 host，CRLF 防注入
        //（HeaderName 恒为小写，直接比较免小写化分配）
        let mut proxy_headers = reqwest::header::HeaderMap::new();
        let target_host_value = format!("{}:{}", mapping.target_host, mapping.target_port);
        for (name, value) in headers.iter() {
            if SKIP_REQUEST_HEADERS.contains(&name.as_str()) || name == "host" {
                continue;
            }
            if let Ok(v) = value.to_str() {
                let safe = v.replace(['\r', '\n'], "");
                if let Ok(hv) = reqwest::header::HeaderValue::from_str(&safe) {
                    proxy_headers.insert(name.clone(), hv);
                }
            }
        }
        if let Ok(hv) = reqwest::header::HeaderValue::from_str(&target_host_value) {
            proxy_headers.insert(reqwest::header::HOST, hv);
        }

        // 请求体纯流式透传（双向流式战略）：收到即转发、不缓冲，
        // 大小计数（chunked 超限即中断并回 413）
        let overflow = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut pending_body = Some(axum::body::Body::from_stream(LimitedStream::new(
            body.into_data_stream(),
            MAX_REQUEST_BODY_SIZE,
            Arc::clone(&overflow),
        )));

        // 状态缓存过期兑底：网关认为 Online 但后端进程已被外部杀掉（如部署脚本 pkill）时，
        // 首个请求会连接失败；此时重置为 offline 并冷启动后重试一次，保证「请求到达即服务可用」。
        // 仅对无请求体的方法重试：body 流已被消费，无法重建；带 body 请求维持 502
        let bodyless = matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS" | "DELETE");
        let mut retried = false;

        // netns 服务：经 UDS 泵转发（URI authority 仅占位，连接目标由连接器决定）
        let upstream = loop {
            // 首次尝试用原始流；重试仅发生在 bodyless（原始流为空），用空 body
            let attempt_body = pending_body.take().unwrap_or_default();
            let upstream_result: Result<http::Response<axum::body::Body>, ProxyUpstreamError> = if cfg.netns {
            let client = {
                let mut map = self.uds_clients.lock().unwrap();
                map.entry(cfg.name.clone())
                    .or_insert_with(|| crate::netns::build_uds_client(&cfg.name))
                    .clone()
            };
            // 请求构建用同步闭包（内部可用 ?），失败即返回发送错误
            let build: Result<http::Request<axum::body::Body>, ProxyUpstreamError> = (|| {
                let uri: http::Uri = format!("http://dynapm-netns{path_and_query}")
                    .parse()
                    .map_err(|e: http::uri::InvalidUri| ProxyUpstreamError::Send(e.to_string()))?;
                let mut builder = http::Request::builder()
                    .method(method.clone())
                    .uri(uri)
                    .version(http::Version::HTTP_11);
                for (name, value) in proxy_headers.iter() {
                    if name == "host" || SKIP_REQUEST_HEADERS.contains(&name.as_str()) {
                        continue;
                    }
                    builder = builder.header(name, value);
                }
                if let Ok(hv) = http::HeaderValue::from_str(&target_host_value) {
                    builder = builder.header(http::header::HOST, hv);
                }
                builder
                    .body(attempt_body)
                    .map_err(|e| ProxyUpstreamError::Send(e.to_string()))
            })();
            let req = match build {
                Ok(r) => r,
                Err(e) => return proxy_request_error_response(e, cfg, rt, &overflow),
            };
            let send_fut = tokio::time::timeout(
                Duration::from_millis(self.params().proxy_timeout_ms),
                client.request(req),
            );
            match send_fut.await {
                Ok(Ok(resp)) => {
                    let mut out = http::Response::builder().status(resp.status());
                    for (k, v) in resp.headers().iter() {
                        out = out.header(k, v);
                    }
                    Ok(out
                        .body(axum::body::Body::new(resp.into_body()))
                        .unwrap_or_else(|_| http::Response::builder().status(502).body(Default::default()).unwrap()))
                }
                Ok(Err(e)) => Err(ProxyUpstreamError::Send(e.to_string())),
                Err(_) => Err(ProxyUpstreamError::Timeout),
            }
        } else {
            let reqwest_body = reqwest::Body::wrap_stream(attempt_body.into_data_stream());
            // proxy_timeout_ms 只覆盖「发起连接 → 响应头返回」；响应体时长由 stall_timeout_ms 管理，
            // 不能用 reqwest 的 .timeout()（那是含 body 的总超时，会掐断 SSE/长流式响应）
            let send_fut = tokio::time::timeout(
                Duration::from_millis(self.params().proxy_timeout_ms),
                self.http_client
                    .request(method.clone(), &url)
                    .headers(proxy_headers.clone())
                    .body(reqwest_body)
                    .send(),
            );
            // reqwest 响应统一为 http::Response<axum Body>（与 UDS 分支同型）
            match send_fut.await {
                Ok(Ok(r)) => {
                    let mut out = http::Response::builder().status(r.status());
                    for (k, v) in r.headers().iter() {
                        out = out.header(k, v);
                    }
                    Ok(out
                        .body(axum::body::Body::from_stream(r.bytes_stream()))
                        .unwrap_or_else(|_| http::Response::builder().status(502).body(Default::default()).unwrap()))
                }
                Ok(Err(e)) => Err(ProxyUpstreamError::Send(e.to_string())),
                Err(_) => Err(ProxyUpstreamError::Timeout),
                Err(e) => Err(ProxyUpstreamError::Send(e.to_string())),
            }
        };
            match upstream_result {
                Ok(r) => break Ok(r),
                Err(e) => {
                    if overflow.load(Ordering::Relaxed) {
                        break Err(e);
                    }
                    // 后端不可达时将非 proxyOnly 服务状态重置为 offline
                    let was_online = !cfg.proxy_only && rt.status() == Status::Online;
                    if was_online {
                        logger::info(&format!("🔄 [{}] 后端不可达，重置状态为 offline", cfg.name));
                        rt.close_session();
                        rt.set_status(Status::Offline);
                    }
                    if matches!(e, ProxyUpstreamError::Timeout) {
                        break Err(e);
                    }
                    // 状态缓存过期：冷启动后重试一次（仅小 body，可重放）
                    if was_online && bodyless && !retried {
                        logger::info(&format!("🔁 [{}] 后端已死但状态为在线，冷启动后重试", cfg.name));
                        if self.ensure_ready(&mapping).await.is_ok() {
                            retried = true;
                            continue;
                        }
                    }
                    break Err(e);
                }
            }
        };

        let upstream = match upstream {
            Ok(r) => r,
            Err(e) => {
                if overflow.load(Ordering::Relaxed) {
                    return text_response(axum::http::StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large");
                }
                logger::error(&format!("❌ [{}] 代理请求错误", cfg.name), Some(&e.to_string()));
                if matches!(e, ProxyUpstreamError::Timeout) {
                    return text_response(axum::http::StatusCode::GATEWAY_TIMEOUT, "Gateway Timeout");
                }
                if !bodyless {
                    // 后端在请求体发送中断开连接（如对不存在端点提前回 404 不读 body 即断连）：
                    // 不合成 502，直接断开客户端连接，转发行为与后端对齐
                    let gone = futures_util::stream::once(async {
                        Err::<bytes::Bytes, std::io::Error>(std::io::Error::new(
                            std::io::ErrorKind::ConnectionAborted,
                            "upstream closed during request body transfer",
                        ))
                    });
                    // body 立即出错 → hyper 在写出响应头之前直接断开连接（不合成 502 文本响应）
                    return http::Response::builder()
                        .status(axum::http::StatusCode::BAD_GATEWAY)
                        .body(axum::body::Body::from_stream(gone))
                        .unwrap_or_else(|_| http::Response::builder().status(502).body(Default::default()).unwrap());
                }
                return text_response(axum::http::StatusCode::BAD_GATEWAY, "Bad Gateway");
            }
        };

        // 请求指标：请求数（含分钟桶历史）+ 上游响应耗时（转发开始→响应头返回）
        rt.record_request();
        rt.total_request_ms
            .fetch_add(proxy_started_at.elapsed().as_millis() as i64, Ordering::Relaxed);

        if overflow.load(Ordering::Relaxed) {
            return text_response(axum::http::StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large");
        }

        let status_code = axum::http::StatusCode::from_u16(upstream.status().as_u16())
            .unwrap_or(axum::http::StatusCode::BAD_GATEWAY);

        let mut response_headers = axum::http::HeaderMap::new();
        for (name, value) in upstream.headers().iter() {
            if SKIP_RESPONSE_HEADERS.contains(&name.as_str()) {
                continue;
            }
            response_headers.insert(name.clone(), value.clone());
        }

        if logger::request_log_enabled() {
            logger::info(&format!(
                "📤 [{}] {} {path_and_query} - {}",
                cfg.name,
                method.as_str(),
                upstream.status().as_u16()
            ));
        }

        let body = upstream.into_body();
        // 响应体停滞超时：每收到一块字节重置计时，连续无进展超过 stallTimeoutMs
        // 即中断响应流（防慢客户端挂住连接；0 = 禁用）
        let body = if self.params().stall_timeout_ms > 0 {
            Body::from_stream(StallTimeoutStream::new(
                body.into_data_stream(),
                self.params().stall_timeout_ms,
            ))
        } else {
            body
        };
        let mut out = axum::response::Response::builder().status(status_code);
        for (name, value) in response_headers.iter() {
            out = out.header(name, value);
        }
        out.body(body)
            .unwrap_or_else(|_| text_response(axum::http::StatusCode::BAD_GATEWAY, "Bad Gateway"))
    }

    /// WS 升级处理：桥接客户端 WebSocket 与上游 WebSocket（透传鉴权/Origin/子协议头）
    pub async fn handle_ws_upgrade(
        self: &Arc<Self>,
        mapping: Arc<RouteMapping>,
        ws: WebSocketUpgrade,
        path_and_query: String,
        headers: axum::http::HeaderMap,
    ) -> axum::response::Response {
        // WS 冷请求同样要走按需启动：服务未就绪时直接拒绝，不做升级
        if let Err(e) = self.ensure_ready(&mapping).await {
            logger::warn(&format!("⚠️ 服务不可用: {}", e));
            return text_response(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Service Unavailable");
        }
        // 客户端请求的子协议透传给 axum 升级响应（后端接受哪个由上游握手结果决定，
        // 这里先全部声明为可接受，客户端侧校验上游回显）
        let protocols: Vec<String> = headers
            .get("sec-websocket-protocol")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(',').map(|p| p.trim().to_string()).collect())
            .unwrap_or_default();
        let mut ws = ws;
        if !protocols.is_empty() {
            ws = ws.protocols(protocols); // Vec<String> 直接传值，axum 接受 IntoIterator<Item: Into<Cow<'static, str>>>
        }
        let gw = Arc::clone(self);
        ws.on_upgrade(move |client_ws| async move {
            gw.ws_bridge(client_ws, mapping, path_and_query, headers).await;
        })
    }

    /// 双向 WS 消息桥
    async fn ws_bridge(
        self: &Arc<Self>,
        client_ws: WebSocket,
        mapping: Arc<RouteMapping>,
        path_and_query: String,
        client_headers: axum::http::HeaderMap,
    ) {
        let rt = Arc::clone(&mapping.service);
        let cfg = &rt.config;
        rt.last_access_ms.store(now_ms() as i64, Ordering::Relaxed);
        rt.active_connections.fetch_add(1, Ordering::Relaxed);
        // 桥接停滞超时：链路无字节进展超过 stallTimeoutMs 即断开（0 = 禁用）
        let stall_timeout_ms = self.params().stall_timeout_ms;

        let scheme = if mapping.target_https { "wss" } else { "ws" };
        let upstream_url = format!(
            "{}://{}:{}{}",
            scheme, mapping.target_host, mapping.target_port, path_and_query
        );

        // netns 服务：先连 UDS 泵拿到字节流，再在其上做 WebSocket 握手；
        // 普通 TCP 后端同样走 client_async，两者共用统一流类型
        let stream_res: std::io::Result<WsUpstreamStream> = if cfg.netns {
            match tokio::time::timeout(
                Duration::from_secs(5),
                crate::netns::connect_uds(&crate::netns::sock_path(&cfg.name)),
            )
            .await
            {
                Ok(r) => r.map(WsUpstreamStream::Uds),
                Err(_) => Err(ws_connect_timeout()),
            }
        } else {
            match tokio::time::timeout(
                Duration::from_secs(5),
                tokio::net::TcpStream::connect((mapping.target_host.as_str(), mapping.target_port)),
            )
            .await
            {
                Ok(r) => r.map(WsUpstreamStream::Tcp),
                Err(_) => Err(ws_connect_timeout()),
            }
        };
        let upstream = match stream_res {
            Ok(stream) => {
                // 统一走 client_async_tls：wss:// 上游做 rustls TLS 握手（对任意
                // AsyncRead+Write 流生效，含 UDS 泵流）；ws:// 上游自动不套 TLS。
                // 客户端头（鉴权/Origin/子协议等）透传到上游握手请求
                let build: Result<http::Request<()>, String> = (|| -> Result<http::Request<()>, String> {
                    let uri: http::Uri = upstream_url
                        .parse()
                        .map_err(|e: http::uri::InvalidUri| e.to_string())?;
                    let mut builder = http::Request::builder().uri(uri);
                    // Host 从上游 URL 重写（tungstenite 校验此头）
                    let upstream_authority = format!("{}:{}", mapping.target_host, mapping.target_port);
                    builder = builder.header(http::header::HOST, upstream_authority);
                    // 握手基头：tungstenite 收到完整 Request 时不代生成任何握手头，需全自带
                    builder = builder.header(http::header::CONNECTION, "Upgrade");
                    builder = builder.header(http::header::UPGRADE, "websocket");
                    builder = builder.header("sec-websocket-version", "13");
                    builder = builder.header("sec-websocket-key", ws_handshake_key());
                    // 业务头透传（鉴权/Origin/子协议/Cookie 等）；
                    for (name, value) in client_headers.iter() {
                        // sec-websocket-protocol 必须保留（子协议透传）；其余握手基头跳过（上面已生成）
                        if SKIP_REQUEST_HEADERS.contains(&name.as_str())
                            || name == "host"
                            || name == "upgrade"
                            || name == "sec-websocket-key"
                            || name == "sec-websocket-version"
                            || name == "sec-websocket-extensions"
                            || name == "sec-websocket-accept"
                        {
                            continue;
                        }
                        builder = builder.header(name, value);
                    }
                    builder.body(()).map_err(|e| e.to_string())
                })();
                match build {
                    Ok(req) => tokio_tungstenite::client_async_tls(req, stream)
                        .await
                        .map(|(ws, _)| ws),
                    Err(e) => Err(tokio_tungstenite::tungstenite::Error::Io(
                        std::io::Error::new(std::io::ErrorKind::InvalidInput, e),
                    )),
                }
            }
            Err(e) => Err(tokio_tungstenite::tungstenite::Error::Io(e)),
        };
        let upstream = match upstream {
            Ok(ws) => ws,
            Err(e) => {
                logger::error(
                    &format!("❌ [{}] WS 上游连接失败: {upstream_url}", cfg.name),
                    Some(&e.to_string()),
                );
                rt.active_connections.fetch_sub(1, Ordering::Relaxed);
                return;
            }
        };

        if logger::ws_log_enabled() {
            logger::info(&format!("🔌 [{}] WS 已连接上游 {upstream_url}", cfg.name));
        }

        let (mut up_sink, mut up_stream) = upstream.split();
        let (mut client_sink, mut client_stream) = client_ws.split();

        // 客户端 -> 上游
        let rt_c2u = Arc::clone(&rt);
        let c2u = tokio::spawn(async move {
            while let Some(msg) = client_stream.next().await {
                let converted = match msg {
                    Ok(WsMessage::Text(t)) => Some(TungsteniteMessage::Text(t.to_string())),
                    Ok(WsMessage::Binary(b)) => Some(TungsteniteMessage::Binary(b.into())),
                    Ok(WsMessage::Ping(p)) => Some(TungsteniteMessage::Ping(p.into())),
                    Ok(WsMessage::Pong(p)) => Some(TungsteniteMessage::Pong(p.into())),
                    Ok(WsMessage::Close(f)) => Some(TungsteniteMessage::Close(f.map(|f| {
                        tokio_tungstenite::tungstenite::protocol::CloseFrame {
                            code: f.code.into(),
                            reason: f.reason.to_string().into(),
                        }
                    }))),
                    Err(e) => {
                        // 不静默：上游断开原因必须可见（否则 WS 断开无法排查）
                        logger::warn(&format!(
                            "⚠️ [{}] WS 客户端->上游读取错误，断开桥接: {e}",
                            rt_c2u.config.name
                        ));
                        None
                    }
                };
                match converted {
                    Some(m) => {
                        // 慢客户端阻塞反向链路时，上游 send 会持续背压停滞；
                        // 超过 proxyTimeoutMs 无进展即断开，防连接永久挂住
                        let send = if stall_timeout_ms > 0 {
                            tokio::time::timeout(Duration::from_millis(stall_timeout_ms), up_sink.send(m))
                        } else {
                            // 未启用停滞超时：永不超时（等价裸 send）
                            tokio::time::timeout(Duration::from_secs(86400 * 365), up_sink.send(m))
                        };
                        if matches!(send.await, Err(_) | Ok(Err(_))) {
                            break;
                        }
                    }
                    None => break,
                }
            }
            let _ = up_sink.close().await;
        });

        // 上游 -> 客户端
        let rt_u2c = Arc::clone(&rt);
        let u2c = tokio::spawn(async move {
            while let Some(msg) = up_stream.next().await {
                let converted = match msg {
                    Ok(TungsteniteMessage::Text(t)) => Some(WsMessage::Text(t.as_str().into())),
                    Ok(TungsteniteMessage::Binary(b)) => Some(WsMessage::Binary(b.to_vec().into())),
                    Ok(TungsteniteMessage::Ping(p)) => Some(WsMessage::Ping(p.to_vec().into())),
                    Ok(TungsteniteMessage::Pong(p)) => Some(WsMessage::Pong(p.to_vec().into())),
                    Ok(TungsteniteMessage::Close(f)) => {
                        // 关闭码/原因透传给客户端（不透传会变成无码关闭=1005）
                        let f = f.map(|f| axum::extract::ws::CloseFrame {
                            code: f.code.into(),
                            reason: f.reason.to_string().into(),
                        });
                        Some(WsMessage::Close(f))
                    }
                    Err(e) => {
                        logger::warn(&format!(
                            "⚠️ [{}] WS 上游->客户端读取错误，断开桥接: {e}",
                            rt_u2c.config.name
                        ));
                        None
                    }
                    Ok(TungsteniteMessage::Frame(_)) => None,
                };
                match converted {
                    Some(m) => {
                        // 慢客户端停滞超时：client_sink.send 背压超过 proxyTimeoutMs 即断开
                        let send = if stall_timeout_ms > 0 {
                            tokio::time::timeout(Duration::from_millis(stall_timeout_ms), client_sink.send(m))
                        } else {
                            tokio::time::timeout(Duration::from_secs(86400 * 365), client_sink.send(m))
                        };
                        if matches!(send.await, Err(_) | Ok(Err(_))) {
                            logger::warn(&format!(
                                "⚠️ [{}] WS 客户端响应停滞超过 {stall_timeout_ms}ms，断开桥接",
                                rt_u2c.config.name
                            ));
                            break;
                        }
                    }
                    None => break,
                }
            }
            let _ = client_sink.close().await;
        });

        // 连接计数在桥任务结束后统一扣减一次（c2u/u2c 两个转发任务不再各自扣，否则净 -1）
        let _ = tokio::join!(c2u, u2c);
        rt.active_connections.fetch_sub(1, Ordering::Relaxed);

        if logger::ws_log_enabled() {
            logger::info(&format!("🔌 [{}] WS 连接已关闭", cfg.name));
        }
    }

    /// 端口路由 TCP 直通：整条连接纯 TCP 双向拷贝
    /// 启动 passthrough 监听（返回 AbortHandle，由调用方注册，避免重入锁）
    pub fn start_passthrough_listener(self: &Arc<Self>, port: u16, mapping: Arc<RouteMapping>) -> tokio::task::AbortHandle {
        let gw = Arc::clone(self);
        tokio::spawn(async move {
            let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
                Ok(l) => l,
                Err(e) => {
                    logger::error(&format!("❌ 端口 {port} 直通监听失败: {e}"), None);
                    return;
                }
            };
            logger::info(&format!(
                "🎧 端口 {port} TCP 直通 -> {}:{}",
                mapping.target_host, mapping.target_port
            ));
            loop {
                let (client, _) = match listener.accept().await {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                // TCP keepalive：客户端异常死亡（进程被杀/mirrored 网络半开）时
                // 内核探测失败自动关连接，避免 io::copy 永久阻塞、活跃计数泄漏
                {
                    let ka = socket2::SockRef::from(&client);
                    let _ = ka.set_tcp_keepalive(
                        &socket2::TcpKeepalive::new()
                            .with_time(std::time::Duration::from_secs(60))
                            .with_interval(std::time::Duration::from_secs(15)),
                    );
                }
                let mapping = Arc::clone(&mapping);
                let rt = Arc::clone(&mapping.service);
                rt.last_access_ms.store(now_ms() as i64, Ordering::Relaxed);

                // 按需启动：passthrough 也支持冷启动
                let gw2 = Arc::clone(&gw);
                tokio::spawn(async move {
                    if let Err(e) = gw2.ensure_service_online(&mapping).await {
                        logger::error(&format!("❌ [{}] passthrough 启动失败", rt.config.name), Some(&e));
                        return;
                    }
                    let (client, dest) = if mapping.service.config.socks {
                        // SOCKS5 服务模式：与客户端完成握手，拿到实际目标
                        match socks5_handshake(client).await {
                            Ok(v) => v,
                            Err(e) => {
                                logger::info(&format!("🧦 [{}] SOCKS5 握手失败: {}", rt.config.name, e));
                                return;
                            }
                        }
                    } else {
                        (client, String::new())
                    };
                    let mut target = match tokio::net::TcpStream::connect((
                        mapping.target_host.as_str(),
                        mapping.target_port,
                    ))
                    .await
                    {
                        Ok(t) => t,
                        Err(e) => {
                            logger::error(&format!("❌ [{}] TCP 直通连接失败", rt.config.name), Some(&e.to_string()));
                            return;
                        }
                    };
                    if mapping.service.config.socks {
                        // 上游本身是 SOCKS 代理：以客户端原始目标对上游发起 CONNECT
                        if let Err(e) = socks5_connect(&mut target, &dest).await {
                            logger::info(&format!("🧦 [{}] SOCKS5 上游 CONNECT {} 失败: {}", rt.config.name, dest, e));
                            return;
                        }
                    }
                    rt.active_connections.fetch_add(1, Ordering::Relaxed);
                    let (mut cr, mut cw) = tokio::io::split(client);
                    let (mut tr, mut tw) = tokio::io::split(target);
                    let up = tokio::io::copy(&mut cr, &mut tw);
                    let down = tokio::io::copy(&mut tr, &mut cw);
                    let _ = tokio::join!(up, down);
                    rt.active_connections.fetch_sub(1, Ordering::Relaxed);
                });
            }
        })
        .abort_handle()
    }

    /// 端口路由 HTTP 监听：独立 axum server
    /// 启动端口 HTTP 监听（返回 AbortHandle，由调用方注册，避免重入锁）
    pub fn start_port_http_listener(self: &Arc<Self>, port: u16, mapping: Arc<RouteMapping>) -> tokio::task::AbortHandle {
        let gw = Arc::clone(self);
        tokio::spawn(async move {
            let gw_for_route = Arc::clone(&gw);
            let mapping_for_route = Arc::clone(&mapping);
            let app = axum::Router::new().fallback(move |method: axum::http::Method,
                                                         uri: axum::http::Uri,
                                                         headers: axum::http::HeaderMap,
                                                         ws: MaybeWs,
                                                         body: Body| {
                let gw = Arc::clone(&gw_for_route);
                let mapping = Arc::clone(&mapping_for_route);
                async move {
                    let path_and_query = uri
                        .path_and_query()
                        .map(|pq| pq.as_str().to_string())
                        .unwrap_or_else(|| uri.path().to_string());
                    if let Some(ws) = ws.0 {
                        return gw.handle_ws_upgrade(mapping, ws, path_and_query, headers).await;
                    }
                    gw.route_request(mapping, method, path_and_query, headers, body)
                        .await
                }
            });
            let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
                Ok(l) => l,
                Err(e) => {
                    logger::error(&format!("❌ 端口 {port} HTTP 监听失败: {e}"), None);
                    return;
                }
            };
            logger::info(&format!(
                "🎧 端口 {port} HTTP 代理 -> {}:{}",
                mapping.target_host, mapping.target_port
            ));
            if let Err(e) = axum::serve(listener, app).await {
                logger::error(&format!("❌ 端口 {port} HTTP 服务退出: {e}"), None);
            }
        })
        .abort_handle()
    }
}

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 声明的 content-length（无头时 None）
fn declared_content_length(headers: &HeaderMap) -> Option<usize> {
    headers
        .get(http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<usize>().ok())
}

/// 纯文本响应
pub fn text_response(status: axum::http::StatusCode, text: &str) -> axum::response::Response {
    axum::response::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(text.to_string()))
        .unwrap()
}

/** 是否为浏览器导航请求（GET 且 Accept 含 text/html，用于冷启动等待页判定） */
fn is_browser_navigation(method: &http::Method, headers: &HeaderMap) -> bool {
    if method != http::Method::GET {
        return false;
    }
    headers
        .get(http::header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/html"))
        .unwrap_or(false)
}

/** 冷启动等待页：服务正在唤起或启动失败时给浏览器的进度页（自动重试，上限后展示失败原因） */
fn cold_start_waiting_page(service: &str, error: &str) -> axum::response::Response {
    let page = format!(
        r#"<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>正在唤醒 {service} - DynaPM</title>
<style>
  body {{ font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center;
         min-height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0; }}
  .card {{ text-align: center; padding: 3rem; }}
  .spinner {{ width: 42px; height: 42px; margin: 0 auto 1.5rem; border-radius: 50%;
              border: 3px solid #334155; border-top-color: #38bdf8; animation: spin 1s linear infinite; }}
  @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
  .err {{ margin-top: 1rem; font-size: 13px; color: #f87171; word-break: break-all; max-width: 32rem; }}
</style>
</head>
<body>
<div class="card">
  <div class="spinner"></div>
  <h2>正在唤醒 <code>{service}</code> …</h2>
  <p>服务冷启动中，就绪后将自动进入。</p>
  <div class="err" id="err"></div>
</div>
<script>
  // 重试上限：连续 30 次（约 45 秒）仍失败则停止刷新并展示错误
  const KEY = 'dynapm-wait-' + location.host;
  const n = (parseInt(sessionStorage.getItem(KEY) || '0', 10) || 0) + 1;
  if (n <= 30) {{
    sessionStorage.setItem(KEY, String(n));
    setTimeout(() => location.reload(), 1500);
  }} else {{
    sessionStorage.removeItem(KEY);
    document.querySelector('.spinner').style.display = 'none';
    document.querySelector('h2').textContent = '{service} 启动失败';
    document.getElementById('err').textContent = {error:?};
  }}
</script>
</body>
</html>"#,
        service = service,
        error = error
    );
    axum::response::Response::builder()
        .status(axum::http::StatusCode::SERVICE_UNAVAILABLE)
        .header(http::header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(http::header::CACHE_CONTROL, "no-store")
        .body(Body::from(page))
        .unwrap_or_else(|_| text_response(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Service Unavailable"))
}

/// RouteMapping -> RouteConfigResolved（供就绪等待复用）
fn to_resolved(mapping: &RouteMapping) -> crate::config::RouteConfigResolved {
    crate::config::RouteConfigResolved {
        route: RouteValue::Host(String::new()),
        target: mapping.target.clone(),
        target_host: mapping.target_host.clone(),
        target_port: mapping.target_port,
        target_https: mapping.target_https,
    }
}

/// 代理上游错误统一形态（HTTP 与 WS 分支共用超时/发送错误分类）
enum ProxyUpstreamError {
    /// 请求发送失败（连接被拒、UDS 不可达等）
    Send(String),
    /// 代理超时（proxyTimeoutMs）
    Timeout,
}

/// WS 上游连接超时错误
fn ws_connect_timeout() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::TimedOut, "ws 上游连接超时")
}

/// 生成 RFC6455 握手 key（16 字节 base64；只需唯一性不需保密性）
fn ws_handshake_key() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut raw = [0u8; 16];
    // 纳秒时间 + 计数 + 栈地址混合成 16 字节熵
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    let a = &raw as *const _ as usize as u64;
    raw[..8].copy_from_slice(&t.to_le_bytes());
    raw[8..].copy_from_slice(&(a ^ c.wrapping_mul(0x9E37_79B9_7F4A_7C15)).to_le_bytes());
    // base64 标准编码（无三方依赖）
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(24);
    for chunk in raw.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

impl std::fmt::Display for ProxyUpstreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProxyUpstreamError::Send(s) => write!(f, "{s}"),
            ProxyUpstreamError::Timeout => write!(f, "代理请求超时"),
        }
    }
}

/// 上游错误 -> 统一错误响应（413/502/504 + 后端不可达时状态重置）
fn proxy_request_error_response(
    e: ProxyUpstreamError,
    cfg: &crate::config::ServiceConfig,
    rt: &Arc<ServiceRuntime>,
    overflow: &Arc<std::sync::atomic::AtomicBool>,
) -> axum::response::Response {
    if overflow.load(Ordering::Relaxed) {
        return text_response(axum::http::StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large");
    }
    logger::error(&format!("❌ [{}] 代理请求错误", cfg.name), Some(&e.to_string()));
    if !cfg.proxy_only && rt.status() == Status::Online {
        logger::info(&format!("🔄 [{}] 后端不可达，重置状态为 offline", cfg.name));
        rt.close_session();
        rt.set_status(Status::Offline);
    }
    if matches!(e, ProxyUpstreamError::Timeout) {
        return text_response(axum::http::StatusCode::GATEWAY_TIMEOUT, "Gateway Timeout");
    }
    text_response(axum::http::StatusCode::BAD_GATEWAY, "Bad Gateway")
}

/// WS 上游统一流类型：普通 TCP 后端与 netns UDS 泵共用
enum WsUpstreamStream {
    /// 普通 TCP 后端
    Tcp(tokio::net::TcpStream),
    /// netns UDS 泵
    Uds(tokio::net::UnixStream),
}

impl tokio::io::AsyncRead for WsUpstreamStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            WsUpstreamStream::Tcp(s) => std::pin::Pin::new(s).poll_read(cx, buf),
            WsUpstreamStream::Uds(s) => std::pin::Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for WsUpstreamStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<Result<usize, std::io::Error>> {
        match self.get_mut() {
            WsUpstreamStream::Tcp(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            WsUpstreamStream::Uds(s) => std::pin::Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        match self.get_mut() {
            WsUpstreamStream::Tcp(s) => std::pin::Pin::new(s).poll_flush(cx),
            WsUpstreamStream::Uds(s) => std::pin::Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        match self.get_mut() {
            WsUpstreamStream::Tcp(s) => std::pin::Pin::new(s).poll_shutdown(cx),
            WsUpstreamStream::Uds(s) => std::pin::Pin::new(s).poll_shutdown(cx),
        }
    }
}

/// 响应体停滞超时流：上游→客户端方向长期无字节进展（stallTimeoutMs）时
/// 主动报错中断，防慢客户端把连接与上游缓冲永久挂住。
/// 计时按「进展」重置：每成功产出一块 chunk 重新起表，长轮询/SSE 只要有
/// 周期性心跳即不受影响；流自然结束（None）不触发超时
struct StallTimeoutStream<S> {
    inner: S,
    timeout_ms: u64,
    /// 下一次允许停滞到期的时刻（首块字节前不计时）
    deadline: Option<tokio::time::Instant>,
    /// 定时器（Pin 在堆上，deadline 变更时 reset）
    sleep: std::pin::Pin<Box<tokio::time::Sleep>>,
}

impl<S> StallTimeoutStream<S> {
    fn new(inner: S, timeout_ms: u64) -> Self {
        Self {
            inner,
            timeout_ms,
            deadline: None,
            sleep: Box::pin(tokio::time::sleep(Duration::from_secs(86400 * 365))),
        }
    }
}

impl<S, E> futures_util::Stream for StallTimeoutStream<S>
where
    S: futures_util::Stream<Item = Result<Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        // 先注册定时器 waker：停滞到期时唤醒本任务，下一次 poll 返回超时错误
        if self.deadline.is_some() && self.sleep.as_mut().poll(cx).is_ready() {
            return std::task::Poll::Ready(Some(Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("响应体停滞超过 {}ms，断开连接", self.timeout_ms),
            ))));
        }
        match std::pin::Pin::new(&mut self.inner).poll_next(cx) {
            std::task::Poll::Ready(Some(Ok(chunk))) => {
                let dl = tokio::time::Instant::now() + Duration::from_millis(self.timeout_ms);
                self.deadline = Some(dl);
                self.sleep.as_mut().reset(dl);
                std::task::Poll::Ready(Some(Ok(chunk)))
            }
            std::task::Poll::Ready(Some(Err(e))) => std::task::Poll::Ready(Some(Err(
                std::io::Error::new(std::io::ErrorKind::Other, e.to_string()),
            ))),
            std::task::Poll::Ready(None) => std::task::Poll::Ready(None),
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

/// 请求体大小限制流：计数超限时置位 overflow 标记并中断流（发送失败 -> 413）
struct LimitedStream<S> {
    inner: S,
    remaining: usize,
    overflow: Arc<std::sync::atomic::AtomicBool>,
}

impl<S> LimitedStream<S> {
    fn new(
        inner: S,
        max: usize,
        overflow: Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        Self { inner, remaining: max, overflow }
    }
}

impl<S> futures_util::Stream for LimitedStream<S>
where
    S: futures_util::Stream<Item = Result<Bytes, axum::Error>> + Unpin,
{
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        match std::pin::Pin::new(&mut self.inner).poll_next(cx) {
            std::task::Poll::Ready(Some(Ok(chunk))) => {
                if chunk.len() > self.remaining {
                    self.overflow.store(true, Ordering::Relaxed);
                    return std::task::Poll::Ready(Some(Err(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "payload too large",
                    ))));
                }
                self.remaining -= chunk.len();
                std::task::Poll::Ready(Some(Ok(chunk)))
            }
            std::task::Poll::Ready(Some(Err(e))) => {
                std::task::Poll::Ready(Some(Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e.to_string(),
                ))))
            }
            std::task::Poll::Ready(None) => std::task::Poll::Ready(None),
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}


/// isRunning 的运行时便捷封装（admin API 用）
#[allow(dead_code)]
pub async fn service_is_running(rt: &ServiceRuntime) -> bool {
    crate::state::is_running(&rt.config, false).await
}

/** 读满 n 字节（对端提前关闭则报错） */
async fn read_exact_or(
    stream: &mut tokio::net::TcpStream,
    buf: &mut [u8],
) -> Result<(), String> {
    stream
        .read_exact(buf)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/**
 * SOCKS5 服务端握手：无鉴权 + CONNECT
 * 返回 (客户端流, 目标地址 "host:port")，握手失败时已向客户端回了错误应答
 */
async fn socks5_handshake(
    mut stream: tokio::net::TcpStream,
) -> Result<(tokio::net::TcpStream, String), String> {
    // greeting: VER NMETHODS METHODS...
    let mut hdr = [0u8; 2];
    read_exact_or(&mut stream, &mut hdr).await?;
    if hdr[0] != 0x05 {
        return Err(format!("不支持的协议版本 {}", hdr[0]));
    }
    let mut methods = vec![0u8; hdr[1] as usize];
    read_exact_or(&mut stream, &mut methods).await?;
    // 选无鉴权 (0x00)；客户端不支持则拒绝
    let method = if methods.contains(&0x00) { 0x00 } else { 0xFF };
    stream.write_all(&[0x05, method]).await.map_err(|e| e.to_string())?;
    if method == 0xFF {
        return Err("客户端不支持无鉴权".to_string());
    }
    // request: VER CMD RSV ATYP ADDR...
    let mut req = [0u8; 4];
    read_exact_or(&mut stream, &mut req).await?;
    if req[1] != 0x01 {
        return Err(format!("仅支持 CONNECT，收到 CMD {}", req[1]));
    }
    let host = match req[3] {
        0x01 => {
            let mut b = [0u8; 4];
            read_exact_or(&mut stream, &mut b).await?;
            std::net::Ipv4Addr::from(b).to_string()
        }
        0x04 => {
            let mut b = [0u8; 16];
            read_exact_or(&mut stream, &mut b).await?;
            std::net::Ipv6Addr::from(b).to_string()
        }
        0x03 => {
            let mut l = [0u8; 1];
            read_exact_or(&mut stream, &mut l).await?;
            let mut b = vec![0u8; l[0] as usize];
            read_exact_or(&mut stream, &mut b).await?;
            String::from_utf8_lossy(&b).to_string()
        }
        t => return Err(format!("不支持的 ATYP {t}")),
    };
    let mut pb = [0u8; 2];
    read_exact_or(&mut stream, &mut pb).await?;
    let port = u16::from_be_bytes(pb);
    // 成功应答：VER REP RSV ATYP BND.ADDR(0.0.0.0) BND.PORT(0)
    stream
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|e| e.to_string())?;
    Ok((stream, format!("{host}:{port}")))
}

/** 作为 SOCKS5 客户端对上游代理发起 CONNECT（无鉴权），成功后流进入可转发状态 */
async fn socks5_connect(
    stream: &mut tokio::net::TcpStream,
    dest: &str,
) -> Result<(), String> {
    let (host, port) = dest
        .rsplit_once(':')
        .ok_or_else(|| format!("非法目标 {dest}"))?;
    let port: u16 = port.parse().map_err(|_| format!("非法端口 {dest}"))?;
    // greeting：只要无鉴权
    stream.write_all(&[0x05, 0x01, 0x00]).await.map_err(|e| e.to_string())?;
    let mut resp = [0u8; 2];
    read_exact_or(stream, &mut resp).await?;
    if resp[0] != 0x05 || resp[1] != 0x00 {
        return Err(format!("上游拒绝无鉴权 (method {})", resp[1]));
    }
    // request：按 host 形态选 ATYP
    let mut req = vec![0x05, 0x01, 0x00];
    if let Ok(v4) = host.parse::<std::net::Ipv4Addr>() {
        req.push(0x01);
        req.extend_from_slice(&v4.octets());
    } else if let Ok(v6) = host.parse::<std::net::Ipv6Addr>() {
        req.push(0x04);
        req.extend_from_slice(&v6.octets());
    } else {
        let b = host.as_bytes();
        if b.len() > 255 {
            return Err("域名过长".to_string());
        }
        req.push(0x03);
        req.push(b.len() as u8);
        req.extend_from_slice(b);
    }
    req.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&req).await.map_err(|e| e.to_string())?;
    // response: VER CMD RSV ATYP ...
    let mut r = [0u8; 4];
    read_exact_or(stream, &mut r).await?;
    if r[1] != 0x00 {
        return Err(format!("上游 CONNECT 失败 (REP {})", r[1]));
    }
    let skip = match r[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut l = [0u8; 1];
            read_exact_or(stream, &mut l).await?;
            l[0] as usize
        }
        _ => return Err(format!("上游回包 ATYP {}", r[3])),
    };
    let mut rest = vec![0u8; skip + 2];
    read_exact_or(stream, &mut rest).await?;
    Ok(())
}
