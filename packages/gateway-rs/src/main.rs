//! DynaPM Rust 网关主入口
//!
//! 启动：`DYNAPM_CONFIG=dynapm.config.json dynapm`
//! 配置格式：与 Bun 版字段一致（JSON），loader 语义对齐

mod admin;
mod admin_http;
mod cli;
mod config;
mod executor;
mod gateway;
mod health;
mod logger;
mod netns;
mod panel;
mod procreg;
mod state;
mod stats;

/** 进程启动时刻（unix 毫秒）：lib crate 实现，bin 内转发（main.rs 不依赖 lib crate root） */
fn process_start_ms() -> u64 {
    dynapm_gateway_rs::process_start_ms()
}

use axum::body::Body;
use config::DynaPMConfig;
use gateway::{Gateway, MaybeWs};
use state::ServiceRuntime;
use std::sync::Arc;

/// 主监听 fallback：hostname 路由（含按需启动）/ 兜底 404；
/// 升级请求（Upgrade: websocket）直接在此噢探接管，不依赖前置代理重写路径
async fn main_fallback(
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    ws: MaybeWs,
    axum::Extension(gw): axum::Extension<Arc<Gateway>>,
    body: Body,
) -> axum::response::Response {
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| uri.path().to_string());

    let host_header = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_string();

    // 专属管理域名根路径直接托管面板（无 /_dynapm 前缀）
    if gw.admin_host().as_deref() == Some(host_header.as_str()) && !uri.path().starts_with("/_dynapm") {
        return panel::serve_root(uri.path());
    }

    match gw.find_hostname_route(&host_header) {
        Some(mapping) => {
            // WS 升级请求噢探接管
            if let Some(ws) = ws.0 {
                return gw.handle_ws_upgrade(mapping, ws, path_and_query, headers).await;
            }
            gw.route_request(mapping, method, path_and_query, headers, body).await
        }
        None => {
            logger::info(&format!("❌ [{host_header}] {} - 404", method.as_str()));
            gateway::text_response(
                axum::http::StatusCode::NOT_FOUND,
                &format!("Service not found: {host_header}"),
            )
        }
    }
}

/// 从已构造的 Request 重新走 main_fallback 逻辑（middleware 中 Host 不匹配时复用）
async fn main_fallback_from_request(req: axum::http::Request<axum::body::Body>) -> axum::response::Response {
    let (mut parts, body) = req.into_parts();
    let gw = parts
        .extensions
        .remove::<Arc<Gateway>>()
        .expect("gateway extension 必存在");
    let method = parts.method;
    let uri = parts.uri;
    let headers = parts.headers;
    main_fallback(method, uri, headers, MaybeWs(None), axum::Extension(gw), body).await
}

/// 构建主监听路由：admin API 路由 + WS 升级专用路由 + fallback 代理
fn build_main_router(gw: Arc<Gateway>) -> axum::Router {
    use axum::middleware;
    use axum::routing::{get, post};

    // admin 面板域名限定：默认拒绝——仅 adminApi.host 专属域名、
    // 服务级 adminPanel: true 的域名、本机回环可达 /_dynapm；
    // 其余 Host 的 /_dynapm 请求改走 fallback 代理透传给后端
    let gw_for_mw = Arc::clone(&gw);
    let ws_route = move |ws: axum::extract::ws::WebSocketUpgrade,
                         uri: axum::http::Uri,
                         headers: axum::http::HeaderMap,
                         axum::Extension(gw): axum::Extension<Arc<Gateway>>| {
        async move {
            let path_and_query = uri
                .path_and_query()
                .map(|pq| pq.as_str().to_string())
                .unwrap_or_else(|| uri.path().to_string());
            let host_header = headers
                .get(axum::http::header::HOST)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .split(':')
                .next()
                .unwrap_or("")
                .to_string();
            match gw.find_hostname_route(&host_header) {
                Some(mapping) => gw.handle_ws_upgrade(mapping, ws, path_and_query, headers).await,
                None => gateway::text_response(
                    axum::http::StatusCode::NOT_FOUND,
                    &format!("Service not found: {host_header}"),
                ),
            }
        }
    };

    // admin API 路由单独建 router：鉴权与 gzip 压缩作为横切层只作用于 API，
    // 面板静态资源与代理转发不经过（面板登录门禁在页面侧，静态资源无需 token）
    let api_router = axum::Router::new()
        .route("/_dynapm/api/services", get(admin::list_services))
        .route("/_dynapm/api/services/{name}", get(admin::service_detail))
        .route("/_dynapm/api/services/{name}/stop", post(admin::stop_service))
        .route("/_dynapm/api/services/{name}/start", post(admin::start_service))
        .route("/_dynapm/api/services/{name}/disable", post(admin::disable_service))
        .route("/_dynapm/api/services/{name}/enable", post(admin::enable_service))
        .route("/_dynapm/api/events", get(admin::events))
        .route("/_dynapm/api/stats", get(admin::stats))
        .route("/_dynapm/api/config", get(admin::get_config).put(admin::put_config))
        .route("/_dynapm/api/reload", post(admin::reload_config))
        .route("/_dynapm/api/info", get(admin::get_info))
        .route("/_dynapm/api/restart", post(admin::restart_gateway))
        .layer(middleware::from_fn(admin_http::gzip))
        .layer(middleware::from_fn(admin_http::auth));
    let admin_router = api_router
        .route("/_dynapm/panel", get(panel::panel))
        .route("/_dynapm/panel/", get(panel::panel))
        .route("/_dynapm/panel/{*rest}", get(panel::panel));

    axum::Router::new()
        // WS 升级专用入口：任何路径的 upgrade 请求由客户端/前置代理重写至此，
        // 网关按 Host 头解析路由后桥接上游（语义等价 Bun 版 upgrade 嗅探）
        .route("/_dynapm/ws-upgrade", get(ws_route))
        .merge(admin_router)
        // admin 面板域名限定：配置 adminApi.host 后，/_dynapm 路径仅在专属 Host 可达，
        // 其余 Host（子服务域名）的 /_dynapm 请求改走 fallback 代理透传给后端
        .layer(middleware::from_fn(move |req: axum::http::Request<axum::body::Body>, next: middleware::Next| {
            let gw = Arc::clone(&gw_for_mw);
            async move {
                let host = req
                    .headers()
                    .get(axum::http::header::HOST)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .split(':')
                    .next()
                    .unwrap_or("")
                    .to_string();
                if !gw.host_allows_admin(&host) {
                    // 该 Host 未授权管理面：交给 fallback（hostname 路由透传）
                    let resp = main_fallback_from_request(req).await;
                    return Ok::<_, std::convert::Infallible>(resp);
                }
                // CORS：仅管理面路径生效，Origin 白名单精确匹配（adminApi.corsOrigins，空 = 禁止跨域）。
                // 预检直接短路；实际请求响应追加白名单头，API 鉴权由 admin_http::auth 层统一把关
                let origin = req
                    .headers()
                    .get(axum::http::header::ORIGIN)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let is_admin_path = req.uri().path().starts_with("/_dynapm");
                if is_admin_path && req.method() == axum::http::Method::OPTIONS {
                    let resp = admin::cors_preflight(&gw, origin.as_deref())
                        .unwrap_or_else(|| {
                            axum::response::Response::builder()
                                .status(axum::http::StatusCode::BAD_REQUEST)
                                .body(Body::empty())
                                .unwrap()
                        });
                    return Ok(resp);
                }
                let resp = next.run(req).await;
                let resp = if is_admin_path {
                    admin::apply_cors(&gw, origin.as_deref(), resp)
                } else {
                    resp
                };
                Ok::<_, std::convert::Infallible>(resp)
            }
        }))
        .fallback(main_fallback)
        .layer(axum::Extension(Arc::clone(&gw)))
}

#[tokio::main]
async fn main() {
    // 隐藏子命令：netns 泵进程（由网关在服务 namespace 内拉起，不经配置）
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 4 && args[1] == "__uds-pump" {
        let port: u16 = args[3].parse().unwrap_or(0);
        netns::pump_main(args[2].clone(), port).await;
        return;
    }

    // 顶层帮助 / 版本：-h/--help/help、-V/--version/version
    if args.len() >= 2 {
        match args[1].as_str() {
            "-h" | "--help" | "help" => {
                cli::print_top_help();
                return;
            }
            "-V" | "--version" | "version" => {
                println!("dynapm {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            _ => {}
        }
    }

    // 子命令：systemd 开机自启管理（install/uninstall/enable/disable/status）
    if args.len() >= 2 && args[1] == "service" {
        cli::service_subcommand(&args[2..]);
        return;
    }

    // 子命令：零配置接入 dev-server（扫 package.json dev 脚本 + 自动分配端口 + 写配置 + 触发热加载）
    if args.len() >= 2 && args[1] == "add" {
        cli::add_subcommand(&args[2..]);
        return;
    }

    // 子命令：restart 触发运行中网关自重启（无需 sudo，systemd Restart=always 负责拉起）
    if args.len() >= 2 && args[1] == "restart" {
        cli::gateway_restart_cli();
        return;
    }

    logger::info("DynaPM-Rust 网关启动中...");

    // 统计持久化目录：配置文件同目录下 stats/（配置加载后、服务运行时创建前注入）
    let cfg_path = config::config_path();
    let stats_dir = std::path::Path::new(&cfg_path)
        .parent()
        .map(|p| {
            let d = if p.as_os_str().is_empty() { std::path::PathBuf::from(".") } else { p.to_path_buf() };
            d.join("stats")
        });
    stats::init_dir(stats_dir);

    // 进程组登记簿目录：与配置同目录的 pgids/（网关重启后关停簿记从磁盘恢复）
    let pgid_dir = std::path::Path::new(&cfg_path)
        .parent()
        .map(|p| {
            let d = if p.as_os_str().is_empty() { std::path::PathBuf::from(".") } else { p.to_path_buf() };
            d.join("pgids")
        });
    procreg::init_dir(pgid_dir);

    let cfg = match config::load_config() {
        Ok(c) => c,
        Err(e) => {
            logger::error("加载配置失败", Some(&e));
            std::process::exit(1);
        }
    };
    logger::init(cfg.enable_request_log, cfg.enable_websocket_log);

    // 端口回退判定依据：配置文件是否显式写了 port（未写时允许特权端口失败自动回退冷门端口）
    let port_explicit = std::fs::read_to_string(&cfg_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .map(|v| v.get("port").is_some())
        .unwrap_or(false);

    // 单例保护：目标端口已被占用（典型：systemd 托管实例已在运行）时，
    // 提示直接使用现有实例并退出，而不是回退端口悄悄起第二个网关
    if let Err(hint) = ensure_single_instance(&cfg).await {
        logger::error("检测到已有实例", Some(&hint));
        std::process::exit(1);
    }

    if let Err(e) = run(cfg, port_explicit).await {
        logger::error("启动失败", Some(&e));
        std::process::exit(1);
    }
}

/** 单例探测：待绑定端口已能连通即视为已有实例在跑（网关无论 80 还是回退端口都是 TCP 监听）。
 *  探测必须带超时：WSL mirrored 等环境下连未占用端口不会收到 RST 而是静默丢包，
 *  无超时会让启动永久卡死；窗口内连不上按"无实例"处理，真被占用时后续 bind 失败兜底 */
async fn ensure_single_instance(cfg: &DynaPMConfig) -> Result<(), String> {
    let host = cfg.host.as_str();
    let port = cfg.port;
    let probe = tokio::net::TcpStream::connect((host, port));
    if matches!(
        tokio::time::timeout(std::time::Duration::from_millis(500), probe).await,
        Ok(Ok(_))
    ) {
        let show_port = |p: u16| if p == 80 { String::new() } else { format!(":{p}") };
        let admin_host = cfg
            .admin_api
            .as_ref()
            .and_then(|a| a.host.clone())
            .unwrap_or_else(|| "localhost".into());
        return Err(format!(
            "端口 {host}:{port} 已被占用——DynaPM 网关已在运行（单例，勿重复启动）。\n\
             ↳ 管理面板  http://{admin_host}{}\n\
             如需重启: {} restart  （无需 sudo）\n\
             如需添加服务: {} add",
            show_port(port),
            std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "dynapm".into()),
            std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "dynapm".into()),
        ));
    }
    Ok(())
}

/** 回退端口扫描起点（冷门区段，避开常用 dev 端口与已分配的 41000-41999 前段） */
const FALLBACK_PORT_BASE: u16 = 41890;

/** 探测一个本地可绑定的回退端口（逐个尝试，全部占用返回 None） */
fn pick_fallback_port() -> Option<u16> {
    (FALLBACK_PORT_BASE..FALLBACK_PORT_BASE + 10).find(|p| {
        std::net::TcpListener::bind(("0.0.0.0", *p)).is_ok()
            || std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok()
    })
}

async fn run(cfg: DynaPMConfig, port_explicit: bool) -> Result<(), String> {
    let mut routes = Vec::new();
    // 每服务只建一个运行时：多条路由复用同一实例
    let mut by_name: std::collections::HashMap<String, Arc<ServiceRuntime>> =
        std::collections::HashMap::new();
    for (svc, resolved) in &cfg.resolved_routes {
        let rt = by_name
            .entry(svc.name.clone())
            .or_insert_with(|| ServiceRuntime::new(svc.clone()));
        routes.push((Arc::clone(rt), resolved.clone()));
    }

    let gw = Gateway::new(
        routes,
        cfg.proxy_timeout_ms,
        cfg.stall_timeout_ms,
        cfg.stop_wait_ms,
        cfg.stop_timeout_ms,
        cfg.start_concurrency,
        cfg.admin_api.as_ref().and_then(|a| a.auth_token.clone()),
        cfg.admin_api.as_ref().and_then(|a| a.host.clone()),
        cfg.admin_api
            .as_ref()
            .and_then(|a| a.cors_origins.clone())
            .unwrap_or_default(),
    );
    // 记录启动期监听地址：配置变更时据此判定可否热更（socket 重绑只能重启）
    gw.set_listener(
        cfg.port,
        cfg.host.clone(),
        cfg.admin_api.as_ref().and_then(|a| a.port),
    );
    logger::info(&format!(
        "🚦 冷启动并发上限: {}（timeouts.startConcurrency 可覆盖）",
        cfg.start_concurrency
    ));

    // 端口路由：passthrough 服务走 TCP 直通，其余起独立 HTTP 代理监听
    for (port, mapping) in gw.port_routes_snapshot() {
        let h = if mapping.service.config.passthrough {
            gw.start_passthrough_listener(port, mapping)
        } else {
            gw.start_port_http_listener(port, mapping)
        };
        gw.register_port_listener(port, h);
    }

    gw.start_idle_reaper();

    let host = cfg.host.clone();
    let mut port = cfg.port;
    let bind_result = tokio::net::TcpListener::bind((host.as_str(), port)).await;
    let listener = match bind_result {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && port < 1024 && !port_explicit => {
            // 用户未显式指定端口却撞上特权端口权限：回退冷门端口而不是拒绝启动，
            // 体验优先——启动成功并提示，用户想免端口号时再按指引提权
            let Some(fallback) = pick_fallback_port() else {
                return Err(format!("监听 {host}:{port} 失败且无可用回退端口: {e}"));
            };
            // 拿当前二进制真实路径拼进提示：sudo 的 PATH 不含 ~/.local/bin，
// 直接给完整可复制命令，用户不需要再踩 command not found
            let exe = std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "dynapm".into());
            logger::warn(&format!(
                "⚠️ 无权限绑定特权端口 {port}（<1024），已回退到 {fallback}；如需免端口号访问请提权（以下两种方式二选一）:\n  - systemd 托管（推荐，含开机自启+崩溃拉起）:\n      sudo {exe} service install\n  - 手动提权:\n      sudo setcap 'cap_net_bind_service=+ep' {exe}"
            ));
            port = fallback;
            tokio::net::TcpListener::bind((host.as_str(), port))
                .await
                .map_err(|e2| format!("监听 {host}:{port} 失败: {e2}"))?
        }
        Err(e) => {
            let exe = std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "dynapm".into());
            return Err(if port < 1024 && e.kind() == std::io::ErrorKind::PermissionDenied {
                format!(
                    "监听 {host}:{port} 失败: 无权限绑定特权端口（<1024）。修复方式二选一:\n  - systemd 部署（unit 已内置 AmbientCapabilities）:\n      sudo {exe} service install\n  - 手动提权:\n      sudo setcap 'cap_net_bind_service=+ep' {exe}"
                )
            } else {
                format!("监听 {host}:{port} 失败: {e}")
            });
        }
    };
    logger::info(&format!("📊 主监听已启动 {host}:{port}"));
    logger::info(&format!(
        "✅ DynaPM-Rust 网关已启动，{} 个服务已注册",
        gw.service_count()
    ));

    // 打印各服务的可访问地址：域名路由展示 http://<host>[:port]，端口路由展示 http://<host>:<port>
    // （80 端口省略端口号，与浏览器行为一致）
    let show_port = |p: u16| if p == 80 { String::new() } else { format!(":{p}") };
    for (svc, resolved) in &cfg.resolved_routes {
        let addr = match &resolved.route {
            config::RouteValue::Host(h) => format!("http://{h}{}", show_port(port)),
            config::RouteValue::Port(p) => format!("http://{host}:{p}"),
        };
        logger::info(&format!("   ↳ {}  {}", svc.name, addr));
    }
    // 管理面板入口（有专属域名用域名根路径，否则本机回环 /_dynapm/panel）
    match &cfg.admin_api {
        Some(a) if a.host.is_some() => {
            logger::info(&format!(
                "   ↳ 管理面板  http://{}{}",
                a.host.as_deref().unwrap_or_default(),
                show_port(a.port.unwrap_or(port))
            ));
        }
        _ => logger::info(&format!(
            "   ↳ 管理面板  http://localhost:{port}/_dynapm/panel"
        )),
    }

    let app = build_main_router(Arc::clone(&gw));

    // 优雅退出：SIGINT/SIGTERM 时停止全部在线服务
    let gw_for_shutdown = Arc::clone(&gw);
    tokio::spawn(async move {
        let mut sigint =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).unwrap();
        let mut sigterm =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
        tokio::select! {
            _ = sigint.recv() => {},
            _ = sigterm.recv() => {},
        }
        logger::info("⚠️ 收到退出信号，正在清理...");
        gw_for_shutdown.cleanup().await;
        std::process::exit(0);
    });

    axum::serve(listener, app)
        .await
        .map_err(|e| format!("主服务退出: {e}"))?;
    Ok(())
}
