//! 服务运行时状态与启停管理（与 Bun 版 service-manager.ts / gateway 状态机语义对齐）

use crate::config::{HealthCheckType, RouteConfigResolved, ServiceConfig};
use crate::executor::{self, CommandOptions};
use crate::stats::StatsFile;
use crate::{health, logger};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

/// 服务状态（与 Bun 版 'offline' | 'starting' | 'online' | 'stopping' 对齐）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Status {
    Offline = 0,
    Starting = 1,
    Online = 2,
    Stopping = 3,
}

impl Status {
    /// JSON 序列化名（与 Bun 版 admin API 输出一致）
    pub fn as_str(&self) -> &'static str {
        match self {
            Status::Offline => "offline",
            Status::Starting => "starting",
            Status::Online => "online",
            Status::Stopping => "stopping",
        }
    }
}

/// 服务运行时共享状态
pub struct ServiceRuntime {
    /// 服务配置
    pub config: ServiceConfig,
    /// 状态 watch 通道：waiters 可等待状态变化（如 starting -> online/offline）
    status_tx: watch::Sender<Status>,
    /// watch receiver 保底：send 在无任何 receiver 时会静默失败，必须至少持有一个
    _status_rx: watch::Receiver<Status>,
    /// 最近一次启动失败的错误（starting 结束为 offline 时供 503 细节）
    pub last_start_error: Mutex<Option<String>>,
    /** 最近一次启动耗时（毫秒，starting 开始到 online） */
    pub last_start_duration_ms: AtomicI64,
    /// 最近访问时间（unix 毫秒）
    pub last_access_ms: AtomicI64,
    /// 当前活动连接数（HTTP/SSE/WebSocket）
    pub active_connections: AtomicI64,
    /// 当前运行 pid
    pub pid: Mutex<Option<u32>>,
    /// 最近一次 start 拉起的服务进程组 id（stop 超时时 SIGKILL 兑底用）
    pub start_pgid: Mutex<Option<u32>>,
    /// 启动时间戳（unix 毫秒，online 时有值）
    pub start_time_ms: Mutex<Option<i64>>,
    /// 累计启动次数
    pub start_count: AtomicU64,
    /// 累计运行时长（毫秒）
    pub total_uptime_ms: AtomicI64,
    /// 彻底关停标志：置位后按需启动/手动启动均被拒绝，请求返回 503（区别于 stop：stop 后下次请求会自动拉起）
    pub paused: AtomicBool,
    /// 累计处理请求数
    pub request_count: AtomicU64,
    /// 累计上游响应耗时（毫秒，从转发开始到上游响应头返回）
    pub total_request_ms: AtomicI64,
    /** 持久化历史统计（mmap 文件，30 天分钟请求桶 + 存活区间；打开失败为 None） */
    pub stats: Option<StatsFile>,
    /** 上次 CPU 采样 (jiffies, unix_ms)，用于差值计算 CPU% */
    pub proc_cpu_last: Mutex<Option<(u64, u64)>>,
}

impl ServiceRuntime {
    /// 创建运行时（初始状态与 Bun 版一致：proxyOnly 为 online，否则 offline）
    pub fn new(config: ServiceConfig) -> Arc<Self> {
        let initial = if config.proxy_only { Status::Online } else { Status::Offline };
        let stats = crate::stats::open_for(&config.name);
        let (tx, rx) = watch::channel(initial);
        let now = now_ms();
        Arc::new(Self {
            config,
            status_tx: tx,
            _status_rx: rx,
            last_start_error: Mutex::new(None),
            last_start_duration_ms: AtomicI64::new(0),
            last_access_ms: AtomicI64::new(now as i64),
            active_connections: AtomicI64::new(0),
            pid: Mutex::new(None),
            start_pgid: Mutex::new(None),
            start_time_ms: Mutex::new(None),
            start_count: AtomicU64::new(0),
            total_uptime_ms: AtomicI64::new(0),
            paused: AtomicBool::new(false),
            request_count: AtomicU64::new(0),
            total_request_ms: AtomicI64::new(0),
            stats,
            proc_cpu_last: Mutex::new(None),
        })
    }

    /// 当前状态
    pub fn status(&self) -> Status {
        *self.status_tx.borrow()
    }

    /// 设置状态并通知所有等待者（同步记录存活区间到持久层）
    pub fn set_status(&self, s: Status) {
        if let Some(st) = &self.stats {
            st.record_status(s == Status::Online);
        }
        let _ = self.status_tx.send(s);
    }

    /// 记录一次请求（计数 + 持久层分钟桶）
    pub fn record_request(&self) {
        self.request_count.fetch_add(1, Ordering::Relaxed);
        if let Some(st) = &self.stats {
            st.record_request();
        }
    }

    /// 订阅状态变化（用于等待 starting/stopping 结束）
    pub fn subscribe(&self) -> watch::Receiver<Status> {
        self.status_tx.subscribe()
    }

    /// 结算当前运行会话：累计到 total_uptime 并清空 start_time
    /// （stop、后端不可达重置等一切 online->offline 转换都必须副用，否则历史存活漏计）
    pub fn close_session(&self) {
        // 先拷贝出 start_time 让 guard 立即释放：if-let 条件里的临时 guard
        // 会存活到语句结束，块内再锁同一把 Mutex 会自死锁（非重入锁）
        let start = *self.start_time_ms.lock().unwrap();
        if let Some(t) = start {
            self.total_uptime_ms
                .fetch_add(now_ms() as i64 - t, Ordering::Relaxed);
            *self.start_time_ms.lock().unwrap() = None;
        }
    }

    /// 当前运行时长（含进行中的本次运行）
    pub fn uptime_ms(&self) -> i64 {
        let total = self.total_uptime_ms.load(Ordering::Relaxed);
        if self.status() == Status::Online {
            if let Some(t) = *self.start_time_ms.lock().unwrap() {
                return total + (now_ms() as i64 - t);
            }
        }
        total
    }

    /// 当前会话存活时长（online 中 = now - start_time；非 online = 0）
    pub fn session_uptime_ms(&self) -> i64 {
        if self.status() == Status::Online {
            if let Some(t) = *self.start_time_ms.lock().unwrap() {
                return now_ms() as i64 - t;
            }
        }
        0
    }
}

/// 当前 unix 毫秒
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 路由映射（Bun 版 RouteMapping 对应物）
pub struct RouteMapping {
    /// 服务运行时
    pub service: Arc<ServiceRuntime>,
    /// 目标后端地址
    pub target: String,
    /// 目标主机
    pub target_host: String,
    /// 目标端口
    pub target_port: u16,
    /// 目标是否 https
    pub target_https: bool,
}

/// TCP 端口探测短路 + check 命令兜底判断服务是否运行中
/// trust_tcp_only 时跳过 check 命令兜底（startExec 快路径用：端口未监听视为未运行，省去一次 bash spawn）
pub async fn is_running(service: &ServiceConfig, trust_tcp_only: bool) -> bool {
    // netns 模式：后端端口在 namespace 内，宿主机 TCP 不可见也绝不可探测
    // （宿主机上同端口的其它服务会造成「已运行」误判），走 UDS HTTP 探活
    if service.netns {
        return crate::netns::check_uds_http(&crate::netns::sock_path(&service.name)).await;
    }
    if let Some(port) = health::resolve_service_port(service) {
        if health::check_tcp_port("127.0.0.1", port).await {
            return true;
        }
    }
    if trust_tcp_only {
        return false;
    }
    match &service.commands.check {
        Some(cmd) => {
            let opts = CommandOptions {
                cwd: service.commands.cwd.clone(),
                env: service.commands.env.clone(),
                timeout_ms: Some(30_000),
                ..Default::default()
            };
            executor::check(cmd, &opts).await
        }
        None => false,
    }
}

/// 启动服务（isRunning 短路防重复启动；启动命令超时按失败处理，与 Bun 版一致）
/// 成功时返回本次拉起的进程组 id（供 stop 超时 SIGKILL 兑底）
pub async fn start(service: &ServiceConfig) -> Result<u32, String> {
    // startExec 直启模式信任 TCP 短路：端口未监听即视为未运行，免 check 命令的 bash spawn 开销
    let fast_path = service.commands.start_exec.is_some();
    if is_running(service, fast_path).await {
        logger::info(&format!("[{}] 服务已在运行，跳过启动", service.name));
        return Ok(0);
    }
    if !fast_path && service.commands.start.trim().is_empty() {
        return Err("服务未配置 start 或 startExec 启动命令".to_string());
    }
    logger::info(&format!("[{}] 正在启动...", service.name));
    let mut opts = CommandOptions {
        cwd: service.commands.cwd.clone(),
        env: service.commands.env.clone(),
        timeout_ms: Some(service.start_timeout),
        log_file: service.commands.log_file.clone(),
        ..Default::default()
    };
    if let Some(args) = &service.commands.start_exec {
        // 直启：跳过 bash 中间层，stdio 走 null，无管道无 drain
        if service.netns {
            return spawn_netns_direct(args, service).await;
        }
        return executor::spawn_direct(args, &opts).await;
    }
    // bash 通用方式：启动命令是长驻/后台拉起，不需要收集输出，
    // stdio 直接 null 免掉退出后的 drain 等待与 pipe-EOF 问题
    if service.netns {
        let target_port = health::resolve_service_port(service).unwrap_or(0);
        let wrapped = crate::netns::wrap_start_command(&service.commands.start, &service.name, target_port);
        opts.collect_output = false;
        let result = executor::execute(
            &format!("unshare --user --map-root-user --net -- bash -c {}", shell_quote(&wrapped)),
            &opts,
        )
        .await;
        if result.exit_code != 0 {
            return Err(format!(
                "启动失败: {}\n{}",
                result.stderr.trim(),
                result.stdout.trim()
            ));
        }
        return Ok(result.pgid);
    }
    opts.collect_output = false;
    let result = executor::execute(&service.commands.start, &opts).await;
    if result.exit_code != 0 {
        return Err(format!(
            "启动失败: {}\n{}",
            result.stderr.trim(),
            result.stdout.trim()
        ));
    }
    Ok(result.pgid)
}

/// netns + startExec：在 namespace 内直接 fork/exec（免 bash），泵随后台拉起
/// 返回 0（进程分散在 unshare 与泵两段，pgid 兑底不适用，stop 走命令/泵清理）
async fn spawn_netns_direct(args: &[String], service: &ServiceConfig) -> Result<u32, String> {
    let opts = CommandOptions {
        cwd: service.commands.cwd.clone(),
        env: service.commands.env.clone(),
        timeout_ms: Some(service.start_timeout),
        collect_output: false,
        log_file: service.commands.log_file.clone(),
    };
    // 包裹脚本期望服务进程后台化（bash 版 start 命令自带 &），必须补上
    let mut inner = format!(
        "{} &",
        args.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ")
    );
    // netns 路径经 bash 包裹，logFile 用 shell 重定向实现（等价 >> log 2>&1）
    if let Some(log) = &service.commands.log_file {
        inner = format!("{inner} >> {} 2>&1", shell_quote(log));
    }
    let wrapped = crate::netns::wrap_start_command(&inner, &service.name, health::resolve_service_port(service).unwrap_or(0));
    let result = executor::execute(&format!("unshare --user --map-root-user --net -- bash -c {}", shell_quote(&wrapped)), &opts).await;
    if result.exit_code != 0 {
        return Err(format!(
            "启动失败: {}\n{}",
            result.stderr.trim(),
            result.stdout.trim()
        ));
    }
    Ok(result.pgid)
}

/// 最小 shell 引号包裹（单引号内转义单引号）
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 停止服务：执行 stop 命令（如有），随后在 stopWaitMs 内等待端口关闭；
/// 超时则对 start 拉起的进程组 SIGKILL 兑底（孤儿服务链不可优雅终止时保收敛）
pub async fn stop(
    rt: &ServiceRuntime,
    stop_timeout_ms: u64,
    stop_wait_ms: u64,
) -> Result<(), String> {
    let service = &rt.config;
    if let Some(stop_cmd) = &service.commands.stop {
        let opts = CommandOptions {
            cwd: service.commands.cwd.clone(),
            env: service.commands.env.clone(),
            timeout_ms: Some(stop_timeout_ms),
            ..Default::default()
        };
        let result = executor::execute(stop_cmd, &opts).await;
        if result.exit_code != 0 {
            logger::warn(&format!(
                "[{}] 停止命令退出码 {}（继续等待端口关闭）",
                service.name, result.exit_code
            ));
        }
    }
    // netns 模式：整组兑底杀进程（bash/泵/服务进程同 pgid），
    // 用户 stop 命令可能匹配不到跨 netns 的同名进程
    if service.netns {
        let pgid = *rt.start_pgid.lock().unwrap();
        if let Some(g) = pgid {
            executor::kill_process_group(g);
        }
        let sock = crate::netns::sock_path(&service.name).display().to_string();
        let kill_pump = format!("pkill -f \"__uds-pump {sock}\" || true");
        let opts = CommandOptions {
            timeout_ms: Some(5_000),
            ..Default::default()
        };
        let _ = executor::execute(&kill_pump, &opts).await;
    }
    // 等待端口真正关闭（与 Bun 版 stopService 语义一致）
    // netns 模式：端口在 namespace 内，宿主机不可见，等待 UDS 探活消失即可
    if service.netns {
        let sock = crate::netns::sock_path(&service.name);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(stop_wait_ms);
        while tokio::time::Instant::now() < deadline {
            if !crate::netns::check_uds_http(&sock).await {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        return Ok(());
    }
    if let Some(port) = health::resolve_service_port(service) {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(stop_wait_ms);
        let mut closed = false;
        while tokio::time::Instant::now() < deadline {
            if !health::check_tcp_port("127.0.0.1", port).await {
                closed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if !closed {
            // 兑底：SIGKILL start 拉起的进程组（bash 后台副本 + 服务进程）
            let pgid = *rt.start_pgid.lock().unwrap();
            if let Some(g) = pgid {
                logger::warn(&format!(
                    "[{}] 优雅停止超时，SIGKILL 进程组 {g}",
                    service.name
                ));
                executor::kill_process_group(g);
                // 给内核一点回收时间再复查
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            if let Some(port) = health::resolve_service_port(service) {
                if health::check_tcp_port("127.0.0.1", port).await {
                    return Err("等待服务停止超时".to_string());
                }
            }
        }
    }
    Ok(())
}

/// 等待后端就绪：按服务 healthCheck 类型分派，默认 tcp 快速轮询 + 退避
pub async fn wait_for_backend_ready(
    service: &ServiceConfig,
    mapping: &RouteConfigResolved,
) -> bool {
    let wait_start = now_ms();
    let mut delay = 2u64; // BACKEND_RETRY_FAST_MS
    loop {
        if now_ms() - wait_start > service.start_timeout {
            return false;
        }
        if health::check_target(service, &mapping.target_host, mapping.target_port).await {
            logger::info(&format!(
                "✅ [{}] 服务就绪 (等待{}ms)",
                service.name,
                now_ms() - wait_start
            ));
            return true;
        }
        tokio::time::sleep(Duration::from_millis(delay)).await;
        delay = (delay * 3 / 2).min(50); // BACKEND_RETRY_BACKOFF=1.5, MAX=50
    }
}

/// 等待服务离开某个状态（如 stopping -> offline），带超时
pub async fn wait_status_leave(rt: &ServiceRuntime, from: Status, timeout_ms: u64) -> bool {
    let mut rx = rt.subscribe();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if rt.status() != from {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        // 最长 100ms 轮询一次（与 Bun 版轮询间隔一致），watch 变化即提前返回
        match tokio::time::timeout(Duration::from_millis(100), rx.changed()).await {
            Ok(Ok(())) => continue,
            _ => continue,
        }
    }
}

/// 健康检查类型是否默认 tcp（供 admin 详情输出对齐）
pub fn health_check_type_name(hc: &Option<crate::config::HealthCheckConfig>) -> &'static str {
    match hc.as_ref().map(|h| h.check_type.clone().unwrap_or_default()) {
        Some(HealthCheckType::Http) => "http",
        Some(HealthCheckType::Command) => "command",
        Some(HealthCheckType::None) => "none",
        _ => "tcp",
    }
}

