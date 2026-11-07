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
        .route("/_dynapm/api/reload", post(admin::reload_config))
        .route("/_dynapm/api/info", get(admin::get_info))
        .route("/_dynapm/api/restart", post(admin::restart_gateway))
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
                // 预检直接短路；实际请求响应追加白名单头，鉴权仍由各 handler 的 auth_check 把关
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

    // 子命令：systemd 开机自启管理（install/uninstall/enable/disable/status）
    if args.len() >= 2 && args[1] == "service" {
        service_subcommand(&args[2..]);
        return;
    }

    // 子命令：零配置接入 dev-server（扫 package.json dev 脚本 + 自动分配端口 + 写配置 + 触发热加载）
    if args.len() >= 2 && args[1] == "add" {
        add_subcommand(&args[2..]);
        return;
    }

    // 子命令：restart 触发运行中网关自重启（无需 sudo，systemd Restart=always 负责拉起）
    if args.len() >= 2 && args[1] == "restart" {
        gateway_restart_cli();
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
    // unit 环境里写死 DYNAPM_CONFIG 为当前生效的配置绝对路径（config.rs 统一解析），
    // systemd 工作目录不确定，显式指定避免解析歧义
    let env_line = format!(
        "Environment=DYNAPM_CONFIG={}\n",
        config::config_path().display()
    );
    // 以调用用户身份运行（root 环境无 fnm/pnpm/bun 等用户工具链，冷启动命令会 127）；
    // 绑 80 靠 AmbientCapabilities，无需 root。PATH 注入用户级 bin 目录补齐工具链
    let run_user = std::env::var("SUDO_USER")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "root".into()));
    let user_home = std::env::var("SUDO_USER")
        .ok()
        .and_then(|u| {
            let out = std::process::Command::new("getent").arg("passwd").arg(&u).output().ok()?;
            String::from_utf8_lossy(&out.stdout).split(':').nth(5).map(|s| s.to_string())
        })
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/root".into());
    // fnm 用户级 node 工具链注入：fnm 会话 bin（/run/user/<uid>/fnm_multishells/...）
    // 随 shell 会话变化无法写死，但 default 别名目录是稳定路径；
    // 不注入则网关冷启动 pnpm/npm/node 全部 127
    let fnm_bin = format!("{user_home}/.local/share/fnm/aliases/default/bin");
    let extra_path = if std::path::Path::new(&fnm_bin).exists() {
        format!("{user_home}/.local/bin:{fnm_bin}:/usr/local/bin:/usr/bin:/bin")
    } else {
        format!("{user_home}/.local/bin:/usr/local/bin:/usr/bin:/bin")
    };
    Ok(format!(
        r#"[Unit]
Description=DynaPM Gateway (on-demand service manager)
After=network.target

[Service]
# 以调用用户身份运行：root 环境没有 fnm/pnpm/bun 等用户工具链，冷启动命令会 127
User={run_user}
Group={run_user}
ExecStart={exe}
{env_line}\
Environment=PATH={extra_path}
WorkingDirectory={user_home}
Restart=always
RestartSec=3
# 绑定 80/443 等特权端口（子域名免端口号的 dev 体验）无需 root 运行
AmbientCapabilities=CAP_NET_BIND_SERVICE
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
                    eprintln!("⚠️ 写入 {SYSTEMD_UNIT_PATH} 需要 root，请用 sudo 重新执行（注意：sudo 的 PATH 不含 ~/.local/bin，需用绝对路径）：");
                    eprintln!("   sudo {} service install", std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "dynapm".into()));
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

/** 配置文件路径（与网关 loader 同一解析规则：DYNAPM_CONFIG > 当前目录 > 用户级默认） */
fn cli_config_path() -> std::path::PathBuf {
    config::config_path()
}

/**
 * CLI 二进制版本对齐：cargo build 原地替换二进制后，systemd 托管的运行实例仍是旧代码。
 * 判据：二进制 mtime > 运行实例进程启动时刻（mtime 比对对同文件双角色无效），
 * 旧则调 /_dynapm/api/restart 让网关自重启（systemd 下自行 systemctl restart，无需 sudo），
 * 然后轮询等它回来。网关未运行时静默跳过（下次启动自然用新二进制）
 */
fn ensure_gateway_up_to_date(cfg: &serde_json::Value) {
    let main_port = cfg.get("port").and_then(|p| p.as_u64()).unwrap_or(80) as u16;
    let admin_port = cfg
        .pointer("/adminApi/port")
        .and_then(|p| p.as_u64())
        .unwrap_or(main_port as u64) as u16;
    let token = cfg.pointer("/adminApi/authToken").and_then(|t| t.as_str()).unwrap_or("");
    let Some(own_mtime) = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
    else {
        return;
    };
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap();
    let auth = format!("Bearer {token}");
    let base = format!("http://127.0.0.1:{admin_port}/_dynapm/api");
    let Ok(resp) = client
        .get(format!("{base}/info"))
        .header("Authorization", &auth)
        .send()
    else {
        return; // 网关未运行，跳过
    };
    let Ok(info) = resp.json::<serde_json::Value>() else { return };
    // 运行实例启动时刻：优先自上报（新网关），缺失则用 pid 从 /proc 反算（兼容旧网关）
    let started_at = info
        .get("startedAt")
        .and_then(|m| m.as_u64())
        .filter(|v| *v > 0)
        .unwrap_or_else(|| {
            info.get("pid")
                .and_then(|p| p.as_u64())
                .map(|p| dynapm_gateway_rs::process_start_ms_of(p as u32))
                .unwrap_or(0)
        });
    if started_at == 0 || own_mtime <= started_at + 1_000 {
        return; // 运行实例不早于二进制（1s 容差抵消换算抖动）
    }
    println!("⬆️  检测到网关运行实例为旧版二进制，自动触发自重启...");
    if client
        .post(format!("{base}/restart"))
        .header("Authorization", &auth)
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
    {
        // 轮询等网关回来（最多 15s），新实例启动时刻必然晚于二进制 mtime
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if let Ok(r) = client
                .get(format!("{base}/info"))
                .header("Authorization", &auth)
                .send()
            {
                if let Ok(new_info) = r.json::<serde_json::Value>() {
                    let new_start = new_info.get("startedAt").and_then(|m| m.as_u64()).unwrap_or(0);
                    if new_start > own_mtime {
                        println!("✅ 网关已升级重启完成");
                        return;
                    }
                }
            }
        }
        println!("⚠️ 网关重启中，尚未就绪（可用 systemctl status dynapm.service 查看）");
    }
}

/** CLI 管理面请求基址与认证头：127.0.0.1:{adminPort}/_dynapm/api + Bearer token */
fn cli_admin_base(cfg: &serde_json::Value) -> (String, String) {
    let main_port = cfg.get("port").and_then(|p| p.as_u64()).unwrap_or(80) as u16;
    let admin_port = cfg
        .pointer("/adminApi/port")
        .and_then(|p| p.as_u64())
        .unwrap_or(main_port as u64) as u16;
    let token = cfg.pointer("/adminApi/authToken").and_then(|t| t.as_str()).unwrap_or("");
    (
        format!("http://127.0.0.1:{admin_port}/_dynapm/api"),
        format!("Bearer {token}"),
    )
}

/** `dynapm restart`：调 /_dynapm/api/restart 让运行中网关自重启并轮询等它回来 */
fn gateway_restart_cli() {
    let path = config::config_path();
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| {
            eprintln!("❌ 读取配置 {} 失败: {e}", path.display());
            std::process::exit(1);
        });
    let cfg: serde_json::Value = serde_json::from_str(&content).unwrap_or_else(|e| {
        eprintln!("❌ 解析配置失败: {e}");
        std::process::exit(1);
    });
    let (base, auth) = cli_admin_base(&cfg);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap();
    let info = client
        .get(format!("{base}/info"))
        .header("Authorization", &auth)
        .send()
        .ok()
        .and_then(|r| r.json::<serde_json::Value>().ok());
    let old_pid = info.as_ref().and_then(|i| i.get("pid")).and_then(|p| p.as_u64());
    if info.is_none() {
        eprintln!("❌ 网关未运行或管理面不可达（{base}）");
        std::process::exit(1);
    }
    println!("🔄 触发网关自重启...");
    if !client
        .post(format!("{base}/restart"))
        .header("Authorization", &auth)
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
    {
        eprintln!("❌ 重启指令发送失败");
        std::process::exit(1);
    }
    // 轮询等网关回来（最多 15s）：新实例 pid 变化或 startedAt 刷新即认为完成
    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Ok(r) = client
            .get(format!("{base}/info"))
            .header("Authorization", &auth)
            .send()
        {
            if let Ok(new_info) = r.json::<serde_json::Value>() {
                let new_pid = new_info.get("pid").and_then(|p| p.as_u64());
                let restarted = match (old_pid, new_pid) {
                    (Some(o), Some(n)) => o != n,
                    (_, Some(_)) => true,
                    _ => false,
                };
                if restarted {
                    println!("✅ 网关已重启完成");
                    return;
                }
            }
        }
    }
    println!("⚠️ 网关重启中，尚未就绪（可用 systemctl status dynapm.service 查看）");
}

/** 分配一个未占用端口：跳过配置内各服务 base 已用端口 + 本地 bind 探测（41000 起） */
fn alloc_free_port(cfg: &serde_json::Value) -> Option<u16> {
    let mut used: std::collections::HashSet<u16> = std::collections::HashSet::new();
    if let Some(services) = cfg.get("services").and_then(|s| s.as_object()) {
        for svc in services.values() {
            // base 形如 http://127.0.0.1:41000，取上游端口避免重复分配
            if let Some(base) = svc.get("base").and_then(|b| b.as_str()) {
                if let Some(p) = base.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) {
                    used.insert(p);
                }
            }
        }
    }
    for p in 41000u16..=41999 {
        if used.contains(&p) {
            continue;
        }
        if std::net::TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return Some(p);
        }
    }
    None
}

/// `dynapm add <dir>`：零配置接入 dev-server。
/// 扫描 <dir>/package.json 的 dev/start 脚本，自动分配 41000+ 端口，
/// 以 <目录名>.localhost 域名写入配置并尝试触发热加载——浏览器访问该域名即按需启动。
fn add_subcommand(args: &[String]) {
    let Some(dir_arg) = args.first() else {
        eprintln!("用法: dynapm add <项目目录> [--name <服务名>]");
        eprintln!("  扫描项目 package.json 的 dev 脚本，自动分配端口并写入配置");
        std::process::exit(1);
    };
    let dir = std::fs::canonicalize(dir_arg).unwrap_or_else(|e| {
        eprintln!("❌ 目录不存在: {dir_arg} ({e})");
        std::process::exit(1);
    });
    let pkg_path = dir.join("package.json");
    let pkg: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&pkg_path).unwrap_or_else(|e| {
            eprintln!("❌ 读取 {} 失败: {e}（dynapm add 需要含 package.json 的前端/Node 项目）", pkg_path.display());
            std::process::exit(1);
        }),
    )
    .unwrap_or_else(|e| {
        eprintln!("❌ package.json 解析失败: {e}");
        std::process::exit(1);
    });
    // dev server 脚本探测：常见键优先（vite/dev、uni-app dev:h5、vue-cli serve、start 兜底）
    let script = ["dev", "dev:h5", "serve", "start"]
        .iter()
        .find(|k| pkg.get("scripts").and_then(|s| s.get(*k)).is_some())
        .map(|k| k.to_string());
    let Some(script) = script else {
        eprintln!("❌ package.json 无 dev/start 脚本，无法推断启动命令");
        std::process::exit(1);
    };

    // 配置文件（不存在则创建最小骨架）
    let cfg_path = cli_config_path();
    let mut cfg: serde_json::Value = if cfg_path.exists() {
        serde_json::from_str(&std::fs::read_to_string(&cfg_path).unwrap_or_else(|e| {
            eprintln!("❌ 读取 {} 失败: {e}", cfg_path.display());
            std::process::exit(1);
        }))
        .unwrap_or_else(|e| {
            eprintln!("❌ {} 解析失败: {e}", cfg_path.display());
            std::process::exit(1);
        })
    } else {
        serde_json::json!({ "host": "127.0.0.1", "adminApi": { "host": "dynapm.localhost" }, "services": {} })
    };
    // CLI 版本对齐：运行中的网关若为旧二进制先自重启（写配置前完成，后续 reload 打到新实例）
    ensure_gateway_up_to_date(&cfg);

    let name = args
        .iter()
        .position(|a| a == "--name")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| dir.file_name().unwrap().to_string_lossy().to_string());
    // 多级子域名（foo.bar.localhost）在 macOS/部分解析器下不可靠，统一压成单级：
    // 路径分隔/点号一律转横杠，项目名与域名规则无关地稳定
    // .localhost 是 RFC 6761 特殊域名，本地回环解析零配置，故写死；
    // 需要自定义域名的场景（生产/团队）直接编辑配置文件的 host 字段
    let name = name.replace(['.', '/', '\\'], "-");
    let host = format!("{name}.localhost");

    // 同名服务重复 add：幂等——沿用已有 base 端口，不重新分配（否则 41000→41001 漂移，
// 旧 start 脚本里注入的端口与 base 失配，热加载后冷启动指向错误上游）
    let port = if let Some(existing) = cfg.get("services").and_then(|s| s.get(&host)) {
        let port = existing
            .get("base")
            .and_then(|b| b.as_str())
            .and_then(|b| b.rsplit(':').next())
            .and_then(|p| p.parse::<u16>().ok());
        let Some(port) = port else {
            eprintln!("❌ 配置中已有服务 {host} 但 base 缺端口，请手工修正后重试");
            std::process::exit(1);
        };
        if cfg.get("services").and_then(|s| s.get(&host)).is_some() {
            println!("ℹ️  服务 {host} 已存在，沿用现有配置（端口 {port}）");
        }
        port
    } else {
        let Some(port) = alloc_free_port(&cfg) else {
            eprintln!("❌ 41000-41999 范围内无可用端口");
            std::process::exit(1);
        };
        port
    };

    let dir_str = dir.display().to_string();
    // 包管理器探测：packageManager 字段优先；无声明时按锁文件 mtime 最新者
    // （多锁共存的项目，最近一次 install 用的是哪个包管理器，哪个锁就最新）
    let pm = pkg
        .get("packageManager")
        .and_then(|p| p.as_str())
        .and_then(|s| s.split('@').next())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            [
                ("bun.lockb", "bun"),
                ("bun.lock", "bun"),
                ("pnpm-lock.yaml", "pnpm"),
                ("yarn.lock", "yarn"),
                ("package-lock.json", "npm"),
            ]
            .iter()
            .filter_map(|(f, pm)| {
                std::fs::metadata(dir.join(f))
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(|t| (t, *pm))
            })
            .max_by(|a, b| a.0.cmp(&b.0))
            .map(|(_, pm)| pm.to_string())
            .unwrap_or_else(|| "npm".to_string())
        });
    // 路由用 host（域名）而非 port：port 是网关额外监听端口，dev server 的
    // 41000 是上游端口，域名路由只需 host + base 指向上游
    // stop/check 留空：关停由网关 pgid 簿记 + 端口反查收编（procreg）负责，
    // 字符串匹配（pkill -f "--port N"）会误杀无关进程且停不干净，不再生成
    let svc = serde_json::json!({
        "host": host,
        "base": format!("http://127.0.0.1:{port}"),
        "commands": {
            "start": format!("cd {dir_str} && nohup {pm} run {script} --port {port} > .dynapm.log 2>&1 &")
        },
        "healthCheck": { "type": "tcp" },
        "idleTimeout": 300000,
        "startTimeout": 60000
    });
    if cfg.get("services").and_then(|s| s.as_object()).is_none() {
        cfg["services"] = serde_json::json!({});
    }
    cfg["services"][&host] = svc;

    let content = serde_json::to_string_pretty(&cfg).unwrap();
    let tmp = format!("{}.tmp", cfg_path.display());
    if let Err(e) = std::fs::write(&tmp, &content).and_then(|_| std::fs::rename(&tmp, &cfg_path)) {
        eprintln!("❌ 写入 {} 失败: {e}", cfg_path.display());
        std::process::exit(1);
    }

    println!("✅ 已接入服务 {name}");
    let main_port = cfg.get("port").and_then(|p| p.as_u64()).unwrap_or(80);
    // 80 端口在 URL 中省略（与浏览器行为一致）
    let show_port = |p: u64| if p == 80 { String::new() } else { format!(":{p}") };
    println!("   域名:   http://{host}{}", show_port(main_port));
    println!("   端口:   {port}（dev server 将以 --port {port} 启动）");
    println!("   启动:   {pm} run {script}");
    println!("   首次访问即自动启动，闲置 5 分钟自动停机");

    // 触发热加载：网关在跑则零重启生效；没跑则下次启动自动加载
    let admin_port = cfg
        .pointer("/adminApi/port")
        .and_then(|p| p.as_u64())
        .unwrap_or(main_port) as u16;    let token = cfg.pointer("/adminApi/authToken").and_then(|t| t.as_str()).unwrap_or("");
    let client = reqwest::blocking::Client::new();
    let reloaded = client
        .post(format!("http://127.0.0.1:{admin_port}/_dynapm/api/reload"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false);
    if reloaded {
        println!("♻️  已通知运行中的网关热加载配置（无需重启）");
    } else {
        println!("ℹ️  网关未运行或热加载失败，下次启动网关时自动生效");
    }

    // 管理面板地址：adminApi.host 配了专属域名则用域名，否则本机回环直接可达
    let admin_host = cfg.pointer("/adminApi/host").and_then(|h| h.as_str());
    match admin_host {
        Some(h) => println!("   面板:   http://{h}{}", show_port(admin_port as u64)),
        None => {
            println!("   面板:   http://localhost:{admin_port}/_dynapm/panel");
            println!("   提示:   配置 adminApi.host 为 dynapm.localhost 后，面板可固定用 http://dynapm.localhost:{admin_port}/_dynapm/panel 访问");
        }
    }
    // 域名免端口号提示：非 80 端口时浏览器必须带 :port，改 80 可省略（Linux 需 root/cap_net_bind_service）
    if main_port != 80 {
        println!("   提示:   网关监听 {main_port} 时访问需带端口号；改配置 port 为 80 可直接用 http://{host}（Linux 需 root）");
    }
}
