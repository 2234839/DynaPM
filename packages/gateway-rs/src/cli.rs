//! CLI 子命令实现（add / restart / service / 顶层帮助）
//!
//! 与网关本体分离：main.rs 只负责子命令分发与网关启动，
//! 所有命令行交互逻辑（打印、systemd 管理、配置写入）集中在这里。

/** systemd unit 文件路径（systemd 规范搜索路径，非部署假设） */
const SYSTEMD_UNIT_PATH: &str = "/etc/systemd/system/dynapm.service";
/** systemd unit 名称（systemctl 操作对象） */
const SYSTEMD_UNIT_NAME: &str = "dynapm.service";

/// 顶层帮助文本（-h/--help/help）：无参数时启动网关，其余走子命令
pub fn print_top_help() {
    // 用户可执行文件名为 dynapm（target/release/dynapm），与 lib crate 名无关，故写死
    let name = "dynapm";
    println!(
        "{name} {} — 按需启停的服务网关：请求到达自动拉起服务，闲置自动回收\n\n用法:\n  {name}                启动网关（配置解析规则: $DYNAPM_CONFIG > ./dynapm.config.json > 用户级默认）\n  {name} add <目录>     零配置接入 dev-server（扫 package.json dev 脚本，自动分配端口并写入配置）\n  {name} restart        触发运行中网关自重启（无需 sudo，由 systemd Restart=always 拉起）\n  {name} service <动作> systemd 开机自启管理（install|uninstall|enable|disable|status）\n  {name} -h, --help     显示本帮助\n  {name} -V, --version  显示版本号\n\n更多文档: https://github.com/2234839/DynaPM",
        env!("CARGO_PKG_VERSION")
    );
}

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
        crate::config::config_path().display()
    );
    // 以调用用户身份运行（root 环境无 fnm/pnpm/bun 等用户工具链，冷启动命令会 127）；
    // 绑 80 靠 AmbientCapabilities，无需 root。PATH 注入用户级 bin 目录补齐工具链
    let run_user = std::env::var("SUDO_USER")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "root".into()));
    let user_home = crate::config::user_home();
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
pub fn service_subcommand(args: &[String]) {
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

/**
 * CLI 二进制版本对齐：cargo build 原地替换二进制后，systemd 托管的运行实例仍是旧代码。
 * 判据：二进制 mtime > 运行实例进程启动时刻（mtime 比对对同文件双角色无效），
 * 旧则调 /_dynapm/api/restart 让网关自重启（systemd 下自行 systemctl restart，无需 sudo），
 * 然后轮询等它回来。网关未运行时静默跳过（下次启动自然用新二进制）
 */
fn ensure_gateway_up_to_date(cfg: &serde_json::Value) {
    let Some(own_mtime) = std::env::current_exe()
        .ok()
        .and_then(|p| crate::state::file_mtime_ms(&p))
    else {
        return;
    };
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap();
    let (base, auth) = cli_admin_base(cfg);
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

/** 候选配置路径列表：显式 DYNAPM_CONFIG 优先，其后 cwd 与用户级默认并行探测 */
fn candidate_config_paths() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    if let Ok(p) = std::env::var("DYNAPM_CONFIG") {
        paths.push(std::path::PathBuf::from(p));
    }
    paths.push(std::path::PathBuf::from("dynapm.config.json"));
    // 用户级默认：与 config.rs 的解析规则保持一致（~/.config/dynapm/dynapm.config.json）
    let home = crate::config::user_home();
    paths.push(std::path::Path::new(&home).join(".config/dynapm/dynapm.config.json"));
    paths
}

/**
 * 探测「实际在运行的网关」的管理面：按候选配置路径依次解析 admin base，
 * 逐个向 /info 发短超时探测请求，第一个应答的配置即为运行实例所用配置。
 * 背景：cwd 下存在示例/项目配置而运行实例用的是用户级配置时，
 * 仅按 cwd 解析会找错实例（探测 3000 失败但实例在 80）。全都不通时返回 None。
 */
fn probe_running_admin() -> Option<(String, String, std::path::PathBuf)> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap();
    for path in candidate_config_paths() {
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        let (base, auth) = cli_admin_base(&cfg);
        let reachable = client
            .get(format!("{base}/info"))
            .header("Authorization", &auth)
            .send()
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        if reachable {
            return Some((base, auth, path));
        }
    }
    None
}

/** `dynapm restart`：调 /_dynapm/api/restart 让运行中网关自重启并轮询等它回来 */
pub fn gateway_restart_cli() {
    // 不再只认 cwd 配置：cwd 有示例配置而实例跑在用户级配置上时（port 3000 vs 80）会找错实例，
    // 逐个候选配置探测 /info，谁应答谁就是运行实例
    let Some((base, auth, path)) = probe_running_admin() else {
        eprintln!("❌ 网关未运行或管理面不可达（已探测 DYNAPM_CONFIG / ./dynapm.config.json / ~/.config/dynapm/dynapm.config.json）");
        std::process::exit(1);
    };
    println!("🔌 运行实例配置: {}", path.display());
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
pub fn add_subcommand(args: &[String]) {
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

    // 配置文件（不存在则创建最小骨架）。
    // 优先跟随运行中网关实例所用的配置（探测 /info 应答者）——cwd 存在示例/其他项目
    // 配置时，按 cwd 解析会把服务写错文件且热加载找不到实例；无运行实例才落回本地解析
    let cfg_path = probe_running_admin()
        .map(|(_, _, p)| p)
        .unwrap_or_else(crate::config::config_path);
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
    // 日志集中放在 ~/.dynapm/logs/（pm2 风格），不污染用户项目目录；
    // host 作为文件名天然唯一（同一 host 只有一条服务配置）
    let log_path = crate::config::user_home() + "/.dynapm/logs/" + &host;
    let _ = std::fs::create_dir_all(
        std::path::Path::new(&log_path)
            .parent()
            .expect("日志路径必有父目录"),
    );
    let svc = serde_json::json!({
        "host": host,
        "base": format!("http://127.0.0.1:{port}"),
        "commands": {
            "start": format!(
                "cd {dir_str} && nohup {pm} run {script} --port {port} > {log_path} 2>&1 &"
            )
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
        .unwrap_or(main_port) as u16;
    let token = cfg.pointer("/adminApi/authToken").and_then(|t| t.as_str()).unwrap_or("");
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
