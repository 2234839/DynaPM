//! 核心网关：路由分发、按需启动状态机、流式代理、WS 桥接、闲置回收
//! （与 Bun 版 gateway.ts 行为对齐）

use crate::config::RouteValue;
use crate::logger;
use crate::state::{now_ms, wait_for_backend_ready, wait_status_leave, RouteMapping, ServiceRuntime, Status};
use axum::body::Body;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use bytes::Bytes;
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

/// 全局网关共享状态
pub struct Gateway {
    /// admin 面板专属域名（adminApi.host，None = 不限定）
    pub admin_host: Option<String>,
    /// hostname 路由：hostname -> 路由映射
    pub hostname_routes: Mutex<HashMap<String, Arc<RouteMapping>>>,
    /// 端口路由：端口 -> 路由映射
    pub port_routes: Mutex<HashMap<u16, Arc<RouteMapping>>>,
    /// 按服务名索引的运行时
    pub runtimes: Mutex<HashMap<String, Arc<ServiceRuntime>>>,
    /// 每服务启动互斥锁：并发请求同一服务时串行化启动
    start_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// 代理请求超时（毫秒）
    pub proxy_timeout_ms: u64,
    /// 等待服务停止完成的超时上限（毫秒）
    pub stop_wait_ms: u64,
    /// 停止命令执行超时（毫秒）
    pub stop_timeout_ms: u64,
    /// 共享 HTTP 客户端（内部连接池 keep-alive，按目标自动复用）
    pub http_client: reqwest::Client,
    /// netns 服务专用 UDS HTTP 客户端（每服务一个连接器实例，见 uds_clients）
    pub uds_clients: Mutex<HashMap<String, crate::netns::UdsClient>>,
    /// 服务生命周期事件广播（admin SSE 用）
    pub events: broadcast::Sender<String>,
    /// admin API 认证令牌
    pub admin_auth_token: Option<String>,
}

impl Gateway {
    /// 根据规范化配置构建网关
    pub fn new(
        routes: Vec<(Arc<ServiceRuntime>, crate::config::RouteConfigResolved)>,
        proxy_timeout_ms: u64,
        stop_wait_ms: u64,
        stop_timeout_ms: u64,
        admin_auth_token: Option<String>,
        admin_host: Option<String>,
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
            .pool_max_idle_per_host(32)
            .build()
            .expect("构建 HTTP 客户端失败");

        let (events, _) = broadcast::channel(256);

        Arc::new(Self {
            admin_host,
            hostname_routes: Mutex::new(hostname_routes),
            port_routes: Mutex::new(port_routes),
            runtimes: Mutex::new(runtimes),
            start_locks: Mutex::new(start_locks),
            proxy_timeout_ms,
            stop_wait_ms,
            stop_timeout_ms,
            http_client,
            uds_clients: Mutex::new(HashMap::new()),
            events,
            admin_auth_token,
        })
    }

    /// admin 面板在指定 Host 下是否可达：
    /// 默认拒绝；仅 adminApi.host 专属域名、显式配置 adminPanel 的服务域名、
    /// 以及本机回环（localhost/127.0.0.1/::1）放行
    pub fn host_allows_admin(&self, host: &str) -> bool {
        if matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1") {
            return true;
        }
        if self.admin_host.as_deref() == Some(host) {
            return true;
        }
        self.hostname_routes
            .lock()
            .unwrap()
            .get(host)
            .map(|m| m.service.config.admin_panel)
            .unwrap_or(false)
    }

    /// 发布服务生命周期事件
    pub fn publish_event(&self, msg: String) {
        let _ = self.events.send(msg);
    }

    /// admin API 认证令牌
    pub fn admin_auth_token(&self) -> Option<&String> {
        self.admin_auth_token.as_ref()
    }

    /// 全部运行时快照
    pub fn all_runtimes(&self) -> Vec<Arc<ServiceRuntime>> {
        self.runtimes.lock().unwrap().values().cloned().collect()
    }

    /// 按服务名查运行时
    pub fn runtime(&self, name: &str) -> Option<Arc<ServiceRuntime>> {
        self.runtimes.lock().unwrap().get(name).cloned()
    }

    /// 已注册服务数量
    pub fn service_count(&self) -> usize {
        self.runtimes.lock().unwrap().len()
    }

    /// 订阅服务生命周期事件（admin SSE）
    pub fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.events.subscribe()
    }

    /// 端口路由快照（启动监听用）
    pub fn port_routes_snapshot(&self) -> Vec<(u16, Arc<RouteMapping>)> {
        self.port_routes
            .lock()
            .unwrap()
            .iter()
            .map(|(p, m)| (*p, Arc::clone(m)))
            .collect()
    }

    /// admin API 主动启动：offline -> starting -> online
    pub async fn start_by_name(&self, rt: &Arc<ServiceRuntime>) -> Result<(), String> {
        let lock = self
            .start_locks
            .lock()
            .unwrap()
            .get(&rt.config.name)
            .cloned()
            .expect("启动锁缺失");
        let _guard = lock.lock().await;
        if rt.status() == Status::Online || rt.config.proxy_only {
            return Ok(());
        }
        rt.set_status(Status::Starting);
        let start_result = crate::state::start(&rt.config).await;
        if let Err(e) = start_result {
            rt.set_status(Status::Offline);
            return Err(e);
        }
        let start_pgid = start_result.unwrap_or_default();
        *rt.start_pgid.lock().unwrap() = if start_pgid > 0 { Some(start_pgid) } else { None };
        *rt.pid.lock().unwrap() = if start_pgid > 0 { Some(start_pgid) } else { None };
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

    /// 按 Host 头查找路由
    pub fn find_hostname_route(&self, hostname: &str) -> Option<Arc<RouteMapping>> {
        self.hostname_routes.lock().unwrap().get(hostname).cloned()
    }

    /// 确保服务在线（供启动/等待路径共用）：每服务互斥串行化
    pub async fn ensure_service_online(&self, mapping: &Arc<RouteMapping>) -> Result<(), String> {
        let rt = &mapping.service;
        let cfg = &rt.config;
        if cfg.proxy_only || rt.status() == Status::Online {
            return Ok(());
        }
        let lock = self
            .start_locks
            .lock()
            .unwrap()
            .get(&cfg.name)
            .cloned()
            .expect("启动锁缺失");
        // 持锁进入：并发请求会在锁上排队，前一个完成后后一个直接命中 online 短路
        let _guard = lock.lock().await;

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
        let start_result = crate::state::start(cfg).await;
        if let Err(e) = start_result {
            rt.set_status(Status::Offline);
            *rt.last_start_error.lock().unwrap() = Some(e.clone());
            return Err(e);
        }
        let start_pgid = start_result.unwrap_or_default();
        *rt.start_pgid.lock().unwrap() = if start_pgid > 0 { Some(start_pgid) } else { None };
        *rt.pid.lock().unwrap() = if start_pgid > 0 { Some(start_pgid) } else { None };
        let ready = wait_for_backend_ready(cfg, &to_resolved(mapping)).await;
        if !ready {
            rt.set_status(Status::Offline);
            let err = format!("服务启动超时: 端口 {} 不可用", mapping.target);
            *rt.last_start_error.lock().unwrap() = Some(err.clone());
            return Err(err);
        }
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
    pub async fn stop_service(&self, rt: Arc<ServiceRuntime>) -> Result<(), String> {
        if rt.status() == Status::Offline {
            return Ok(());
        }
        rt.set_status(Status::Stopping);
        rt.close_session();
        let result = crate::state::stop(&rt, self.stop_timeout_ms, self.stop_wait_ms).await;
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
                    gw.runtimes
                        .lock()
                        .unwrap()
                        .values()
                        .cloned()
                        .collect()
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
                        if let Err(e) = gw2.stop_service(Arc::clone(&rt2)).await {
                                logger::error(&format!("❌ [{}] 停止失败", rt2.config.name), Some(&e));
                            }
                        });
                    }
                }
            }
        });
    }

    /// 按需启动状态机：starting 等待 / stopping 等待 / offline 启动，返回是否可代理
    async fn ensure_ready(self: &Arc<Self>, mapping: &Arc<RouteMapping>) -> Result<(), String> {
        let rt = &mapping.service;
        let cfg = &rt.config;
        match rt.status() {
            Status::Starting => self.ensure_service_online(mapping).await,
            Status::Stopping => {
                logger::info(&format!("⏳ [{}] 等待服务停止完成...", cfg.name));
                if wait_status_leave(rt, Status::Stopping, self.stop_wait_ms).await {
                    if rt.status() == Status::Offline {
                        self.ensure_service_online(mapping).await
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
                self.ensure_service_online(mapping).await
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
                Duration::from_millis(self.proxy_timeout_ms),
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
            let send = self
                .http_client
                .request(method.clone(), &url)
                .headers(proxy_headers.clone())
                .body(reqwest_body)
                .timeout(Duration::from_millis(self.proxy_timeout_ms))
                .send()
                .await;
            // reqwest 响应统一为 http::Response<axum Body>（与 UDS 分支同型）
            match send {
                Ok(r) => {
                    let mut out = http::Response::builder().status(r.status());
                    for (k, v) in r.headers().iter() {
                        out = out.header(k, v);
                    }
                    Ok(out
                        .body(axum::body::Body::from_stream(r.bytes_stream()))
                        .unwrap_or_else(|_| http::Response::builder().status(502).body(Default::default()).unwrap()))
                }
                Err(e) if e.is_timeout() => Err(ProxyUpstreamError::Timeout),
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
                        if up_sink.send(m).await.is_err() {
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
                        if client_sink.send(m).await.is_err() {
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
    pub fn start_passthrough_listener(self: &Arc<Self>, port: u16, mapping: Arc<RouteMapping>) {
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
                    let target = match tokio::net::TcpStream::connect((
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
                    rt.active_connections.fetch_add(1, Ordering::Relaxed);
                    let (mut cr, mut cw) = tokio::io::split(client);
                    let (mut tr, mut tw) = tokio::io::split(target);
                    let up = tokio::io::copy(&mut cr, &mut tw);
                    let down = tokio::io::copy(&mut tr, &mut cw);
                    let _ = tokio::join!(up, down);
                    rt.active_connections.fetch_sub(1, Ordering::Relaxed);
                });
            }
        });
    }

    /// 端口路由 HTTP 监听：独立 axum server
    pub fn start_port_http_listener(self: &Arc<Self>, port: u16, mapping: Arc<RouteMapping>) {
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
        });
    }
}

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
