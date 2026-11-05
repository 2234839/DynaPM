//! DynaPM Rust 网关主入口
//!
//! 启动：`DYNAPM_CONFIG=dynapm.config.json dynapm`
//! 配置格式：与 Bun 版字段一致（JSON），loader 语义对齐

mod admin;
mod config;
mod executor;
mod gateway;
mod health;
mod logger;
mod netns;
mod panel;
mod state;
mod stats;

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
    if gw.admin_host.as_deref() == Some(host_header.as_str()) && !uri.path().starts_with("/_dynapm") {
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

    let admin_router = axum::Router::new()
        .route("/_dynapm/api/services", get(admin::list_services))
        .route("/_dynapm/api/services/{name}", get(admin::service_detail))
        .route("/_dynapm/api/services/{name}/stop", post(admin::stop_service))
        .route("/_dynapm/api/services/{name}/start", post(admin::start_service))
        .route("/_dynapm/api/services/{name}/disable", post(admin::disable_service))
        .route("/_dynapm/api/services/{name}/enable", post(admin::enable_service))
        .route("/_dynapm/api/events", get(admin::events))
        .route("/_dynapm/api/stats", get(admin::stats))
        .route("/_dynapm/api/config", get(admin::get_config).put(admin::put_config))
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
                let resp = next.run(req).await;
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

    // 子命令：systemd 开机自启管理（install/uninstall/enable/disable/status）
    if args.len() >= 2 && args[1] == "service" {
        service_subcommand(&args[2..]);
        return;
    }

    logger::info("DynaPM-Rust 网关启动中...");

    // 统计持久化目录：配置文件同目录下 stats/（配置加载后、服务运行时创建前注入）
    let cfg_path = std::env::var("DYNAPM_CONFIG").unwrap_or_else(|_| "dynapm.config.json".to_string());
    let stats_dir = std::path::Path::new(&cfg_path)
        .parent()
        .map(|p| {
            let d = if p.as_os_str().is_empty() { std::path::PathBuf::from(".") } else { p.to_path_buf() };
            d.join("stats")
        });
    stats::init_dir(stats_dir);

    let cfg = match config::load_config() {
        Ok(c) => c,
        Err(e) => {
            logger::error("加载配置失败", Some(&e));
            std::process::exit(1);
        }
    };
    logger::init(cfg.enable_request_log, cfg.enable_websocket_log);

    if let Err(e) = run(cfg).await {
        logger::error("启动失败", Some(&e));
        std::process::exit(1);
    }
}

async fn run(cfg: DynaPMConfig) -> Result<(), String> {
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
        cfg.stop_wait_ms,
        cfg.stop_timeout_ms,
        cfg.admin_api.as_ref().and_then(|a| a.auth_token.clone()),
        cfg.admin_api.as_ref().and_then(|a| a.host.clone()),
    );

    // 端口路由：passthrough 服务走 TCP 直通，其余起独立 HTTP 代理监听
    for (port, mapping) in gw.port_routes_snapshot() {
        if mapping.service.config.passthrough {
            gw.start_passthrough_listener(port, mapping);
        } else {
            gw.start_port_http_listener(port, mapping);
        }
    }

    gw.start_idle_reaper();

    let host = cfg.host.clone();
    let port = cfg.port;
    let app = build_main_router(Arc::clone(&gw));
    let listener = tokio::net::TcpListener::bind((host.as_str(), port))
        .await
        .map_err(|e| format!("监听 {host}:{port} 失败: {e}"))?;
    logger::info(&format!("📊 主监听已启动 {host}:{port}"));
    logger::info(&format!(
        "✅ DynaPM-Rust 网关已启动，{} 个服务已注册",
        gw.service_count()
    ));

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

/// systemd unit 文件路径（systemd 规范搜索路径，非部署假设）
const SYSTEMD_UNIT_PATH: &str = "/etc/systemd/system/dynapm.service";
/// systemd unit 名称（systemctl 操作对象）
const SYSTEMD_UNIT_NAME: &str = "dynapm.service";

/// 生成 systemd unit 内容（二进制路径取当前可执行文件真实路径，配置取 DYNAPM_CONFIG 或默认）
fn render_unit() -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("无法确定当前可执行文件路径: {e}"))?
        .display()
        .to_string();
    // unit 环境里写死 DYNAPM_CONFIG 的当前值；未设置时留空，systemd 环境下由
    // loader 回退到工作目录的 dynapm.config.json（WorkingDirectory 未设则报错，语义清晰）
    let cfg_path = std::env::var("DYNAPM_CONFIG").unwrap_or_default();
    let env_line = if cfg_path.is_empty() {
        String::new()
    } else {
        format!("Environment=DYNAPM_CONFIG={cfg_path}\n")
    };
    Ok(format!(
        r#"[Unit]
Description=DynaPM Gateway (on-demand service manager)
After=network.target

[Service]
ExecStart={exe}
{env_line}Restart=always
RestartSec=3
# 服务子进程由网关统一回收；网关被 systemd 杀掉时子进程组一并终止
KillMode=mixed

[Install]
WantedBy=multi-user.target
"#
    ))
}

/// systemctl 封装（失败即退出）
fn systemctl(args: &[&str]) {
    let st = std::process::Command::new("systemctl").args(args).status();
    match st {
        Ok(s) if s.success() => {}
        Ok(s) => {
            eprintln!("❌ systemctl {} 失败（exit {}）", args.join(" "), s);
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("❌ 执行 systemctl 失败: {e}（本机无 systemd？）");
            std::process::exit(1);
        }
    }
}

/// `dynapm service <install|uninstall|enable|disable|status>`：systemd 开机自启管理。
/// install 写 unit 文件（需 root，非 root 时打印内容与提示后退出），
/// enable/disable/status 转发 systemctl；uninstall 先 stop+disable 再删 unit 文件。
fn service_subcommand(args: &[String]) {
    let action = args.first().map(|s| s.as_str()).unwrap_or("");
    match action {
        "install" => {
            let unit = match render_unit() {
                Ok(u) => u,
                Err(e) => {
                    eprintln!("❌ {e}");
                    std::process::exit(1);
                }
            };
            match std::fs::write(SYSTEMD_UNIT_PATH, &unit) {
                Ok(()) => {
                    println!("✅ 已写入 {SYSTEMD_UNIT_PATH}");
                    systemctl(&["daemon-reload"]);
                    systemctl(&["enable", "--now", SYSTEMD_UNIT_NAME]);
                    println!("✅ 开机自启已开启，网关已启动（systemctl status {SYSTEMD_UNIT_NAME}）");
                }
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    eprintln!("⚠️ 写入 {SYSTEMD_UNIT_PATH} 需要 root，请用 sudo 重新执行：");
                    eprintln!("   sudo {} service install", std::env::args().next().unwrap_or_else(|| "dynapm".into()));
                    eprintln!("--- unit 内容 ---");
                    eprintln!("{unit}");
                    std::process::exit(1);
                }
                Err(e) => {
                    eprintln!("❌ 写入 {SYSTEMD_UNIT_PATH} 失败: {e}");
                    std::process::exit(1);
                }
            }
        }
        "uninstall" => {
            systemctl(&["stop", SYSTEMD_UNIT_NAME]);
            systemctl(&["disable", SYSTEMD_UNIT_NAME]);
            match std::fs::remove_file(SYSTEMD_UNIT_PATH) {
                Ok(()) => println!("✅ 已卸载（网关已停止并移除开机自启）"),
                Err(e) => {
                    eprintln!("❌ 删除 {SYSTEMD_UNIT_PATH} 失败: {e}（需要 root）");
                    std::process::exit(1);
                }
            }
            systemctl(&["daemon-reload"]);
        }
        "enable" => {
            systemctl(&["enable", "--now", SYSTEMD_UNIT_NAME]);
            println!("✅ 开机自启已开启，网关已启动");
        }
        "disable" => {
            systemctl(&["disable", "--now", SYSTEMD_UNIT_NAME]);
            println!("✅ 开机自启已关闭，网关已停止");
        }
        "status" => {
            systemctl(&["status", SYSTEMD_UNIT_NAME]);
        }
        _ => {
            eprintln!("用法: dynapm service <install|uninstall|enable|disable|status>");
            eprintln!("  install   写入 systemd unit 并开启开机自启（需 root）");
            eprintln!("  uninstall 停止网关并移除开机自启");
            eprintln!("  enable    开启开机自启并立即启动网关");
            eprintln!("  disable   关闭开机自启并停止网关");
            eprintln!("  status    查看网关 systemd 状态");
            if !action.is_empty() {
                std::process::exit(1);
            }
        }
    }
}
