//! netns 模式：Docker 式零宿主机端口占用（零权限，无需 root）
//!
//! 原理：服务进程在 user + network namespace（`unshare -Urn`）内运行，
//! 它监听的端口只存在于命名空间内部，宿主机完全不占用；
//! 网关侧拉起一个「泵」进程同处该 netns，把命名空间内的
//! `127.0.0.1:后端端口` 桥接到文件系统上的 unix socket（UDS 不受 netns 管
//! 辖），网关直接向 UDS 转发 HTTP/WebSocket 字节。后端零配合。
//!
//! ```text
//! 宿主机 netns                          服务 netns（unshare -Urn）
//! ┌───────────┐    UDS 文件     ┌────────────────────────────┐
//! │ 网关 ─────┼──/tmp/xxx.sock─┼→ 泵 → 127.0.0.1:PORT → 后端 │
//! └───────────┘                └────────────────────────────┘
//! ```

use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UnixStream};

/// 服务在 netns 内监听后，宿主机侧可探测到的是这个 UDS 文件
pub fn sock_path(service_name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("dynapm-{}.sock", safe_name(service_name)))
}

/** 服务名仅作文件名成分，过滤路径分隔符等非法字符防注入。
 *  sock_path / pump_group_path 共用，禁止内联重写 */
fn safe_name(service_name: &str) -> String {
    service_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// 把原始 start 命令包装为 netns 启动命令：
/// 1. 读 groupfile 杀上一次启动的整个进程组（bash 为组长，泵/服务进程同组；
///    网关重启内存态丢失后靠它兜底，否则旧 netns 里的服务进程变孤儿持续泄漏）
/// 2. 拉起 lo → （outbound）bind 私有 resolv.conf → 后台泵 → 原始启动命令，
///    并把自身 bash pid（= 组长 pgid）写入 groupfile
pub fn wrap_start_command(start_cmd: &str, service_name: &str, target_port: u16, outbound: bool) -> String {
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "dynapm-rs".to_string());
    let sock = sock_path(service_name).display().to_string();
    let groupfile = pump_group_path(service_name).display().to_string();
    // outbound 模式下 DNS 指向 slirp 内置转发器 10.0.2.3；
    // bind 在 ns 自己的 mount ns 内进行（调用方须给 unshare 加 --mount），不动宿主机文件
    let dns_setup = if outbound {
        let resolv = std::env::temp_dir().join(format!("dynapm-{}.resolv", safe_name(service_name))).display().to_string();
        format!("echo 'nameserver 10.0.2.3' > {resolv}\nmount --bind {resolv} /etc/resolv.conf\n")
    } else {
        String::new()
    };
    format!(
        // start_cmd 尾部常以 `&` 结尾，用换行分隔避免 `& ;` 语法错误
        // kill 的目标是进程组：pgid 前必须带负号（-- -<pgid>），只写 pid 会漏杀组内 node/泵
        "if [ -f {groupfile} ]; then kill -9 -- -$(cat {groupfile}) 2>/dev/null; rm -f {groupfile}; fi
ip link set lo up
{dns_setup}nohup {exe} __uds-pump {sock} {target_port} >/dev/null 2>&1 &
{start_cmd}
echo $$ > {groupfile}"
    )
}

/// 泵进程自身的 pid 文件（outbound 中继需要拿一个 netns 内存活进程的 pid）
pub fn pump_pid_path(service_name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("dynapm-{}.proc", safe_name(service_name)))
}

/// 进程组记录文件（组长 bash 的 pid 即 pgid，宿主机可读）
pub fn pump_group_path(service_name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("dynapm-{}.pump.pid", safe_name(service_name)))
}

/** 读取 groupfile 中记录的泵进程组 id（不存在/损坏返回 None）。
 *  网关重启内存态丢失时靠它兜底杀残留进程组 */
pub fn read_pump_pgid(service_name: &str) -> Option<u32> {
    std::fs::read_to_string(pump_group_path(service_name))
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
}


/// 通过 UDS 对后端做真实 HTTP 探活：发出 HEAD 请求，收到任何响应字节即存活
/// （后端未就绪时泵会 dial 失败并关闭连接 → 读到 EOF → false）
pub async fn check_uds_http(path: &std::path::Path) -> bool {
    let probe = async {
        let mut stream = UnixStream::connect(path).await?;
        stream
            .write_all(b"HEAD / HTTP/1.0\r\nHost: dynapm-probe\r\n\r\n")
            .await?;
        let mut buf = [0u8; 1];
        Ok::<bool, std::io::Error>(stream.read(&mut buf).await? >= 1)
    };
    tokio::time::timeout(Duration::from_millis(500), probe)
        .await
        .unwrap_or(Ok(false))
        .unwrap_or(false)
}

/// 打开到 netns 后端的字节流（网关 HTTP/WS 转发共用）
pub async fn connect_uds(path: &std::path::Path) -> std::io::Result<UnixStream> {
    UnixStream::connect(path).await
}

/** 从泵子命令的 sock 参数反推 pid 文件路径：/tmp/dynapm-<name>.sock → /tmp/dynapm-<name>.proc
 *  泵进程不知道服务名，只有 sock 路径；pid 文件与 sock 同目录同名不同后缀 */
fn sock_path_from_arg(sock: &str) -> Option<std::path::PathBuf> {
    let file = std::path::Path::new(sock);
    if file.extension()? != "sock" {
        return None;
    }
    let stem = file.file_stem()?.to_string_lossy().to_string();
    let name = stem.strip_prefix("dynapm-")?.to_string();
    Some(std::env::temp_dir().join(format!("dynapm-{}.proc", safe_name(&name))))
}

/** 探测 slirp4netns 是否可用（outbound 中继唯一工具）。
 *  pasta 不可用于本场景：它拒绝以 root 运行（自动降权 nobody 后打不开 root 属主的
 *  user namespace），而网关常在 root/systemd 下运行；slirp4netns 无此限制 */
fn outbound_tool_available() -> bool {
    std::process::Command::new("which")
        .arg("slirp4netns")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/** 为 netns 服务拉起 outbound 中继（在宿主 netns 运行，目标为泵进程所在 namespace）。
 *  netns 默认只有 lo 无出站网络；pasta/slirp4netns 把 ns 内流量经宿主 socket 转发出去。
 *  中继进程随 namespace 清空自动退出（kill_on_drop 兜底），无需网关显式回收 */
pub async fn spawn_outbound_relay(service_name: String) {
    // 等泵写 pid 文件（冷启动窗口内就绪）
    let pid_path = pump_pid_path(&service_name);
    let pid = {
        let mut waited = 0u64;
        loop {
            if let Ok(text) = std::fs::read_to_string(&pid_path) {
                if let Ok(p) = text.trim().parse::<u32>() {
                    break p;
                }
            }
            if waited >= 15_000 {
                crate::logger::error(
                    "netns outbound 启动失败",
                    Some(&format!("等待泵 pid 文件超时: {}", pid_path.display())),
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            waited += 100;
        }
    };
    let Some(tool) = outbound_tool_available().then_some("slirp4netns") else {
        crate::logger::error(
            "netns outbound 启动失败",
            Some("未找到 slirp4netns，请安装：apt install slirp4netns"),
        );
        return;
    };
    let mut cmd = tokio::process::Command::new(tool);
    cmd.kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .arg("--configure")
        .arg(pid.to_string())
        .arg("tap0");
    match cmd.spawn() {
        Ok(mut child) => {
            crate::logger::info(&format!(
                "[{service_name}] netns outbound 中继已启动（{tool}，目标 pid {pid}）"
            ));
            // 持有并等待：kill_on_drop 在 Child drop 时生效，若此处不等子进程会立刻被回收
            if let Err(e) = child.wait().await {
                crate::logger::error(
                    "netns outbound 中继退出异常",
                    Some(&format!("wait {tool}: {e}")),
                );
            }
            crate::logger::info(&format!("[{service_name}] netns outbound 中继已退出"));
        }
        Err(e) => crate::logger::error(
            "netns outbound 启动失败",
            Some(&format!("spawn {tool}: {e}")),
        ),
    }
}

/// 泵子命令入口（`dynapm-rs __uds-pump <sock> <port>`）
/// 在 netns 内运行：accept UDS 连接，每条连接 dial 命名空间内后端端口后双向透传
pub async fn pump_main(sock: String, port: u16) {
    let _ = tokio::fs::remove_file(&sock).await;
    let listener = match tokio::net::UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("uds-pump bind {sock} 失败: {e}");
            return;
        }
    };
    // pid 文件与 sock 同目录派生：宿主侧 outbound 中继以此定位 netns 内存活进程
    if let Some(pid_path) = sock_path_from_arg(&sock) {
        let _ = std::fs::write(pid_path, std::process::id().to_string());
    }
    loop {
        let Ok((client, _)) = listener.accept().await else {
            continue;
        };
        tokio::spawn(relay(client, port));
    }
}

/// 单连接桥接：dial 后端（带短暂重试，覆盖后端启动窗口）后双向拷贝
async fn relay(client: UnixStream, port: u16) {
    let mut upstream = None;
    for _ in 0..30 {
        if let Ok(s) = TcpStream::connect(("127.0.0.1", port)).await {
            upstream = Some(s);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let Some(upstream) = upstream else {
        return;
    };
    let (mut cr, mut cw) = client.into_split();
    let (mut ur, mut uw) = upstream.into_split();
    let c2u = tokio::spawn(async move { tokio::io::copy(&mut cr, &mut uw).await });
    let u2c = tokio::spawn(async move { tokio::io::copy(&mut ur, &mut cw).await });
    let _ = c2u.await;
    let _ = u2c.await;
}

/// hyper legacy 客户端要求的 IO 类型包装：tokio UnixStream → hyper rt traits + Connection
pub struct UdsIo(hyper_util::rt::TokioIo<UnixStream>);

impl hyper::rt::Read for UdsIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: hyper::rt::ReadBufCursor<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl hyper::rt::Write for UdsIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<Result<usize, std::io::Error>> {
        Pin::new(&mut self.0).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

impl hyper_util::client::legacy::connect::Connection for UdsIo {
    fn connected(&self) -> hyper_util::client::legacy::connect::Connected {
        hyper_util::client::legacy::connect::Connected::new()
    }
}

/// UDS 连接器：hyper legacy 客户端的 tower Service，忽略 Uri、直连固定 UDS 路径
#[derive(Clone)]
pub struct UdsConnector {
    /// UDS 文件路径
    pub path: String,
}

impl tower_service::Service<http::Uri> for UdsConnector {
    type Response = UdsIo;
    type Error = std::io::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _uri: http::Uri) -> Self::Future {
        let path = self.path.clone();
        Box::pin(async move {
            let stream = connect_uds(std::path::Path::new(&path)).await?;
            Ok(UdsIo(hyper_util::rt::TokioIo::new(stream)))
        })
    }
}

use std::future::Future;

/// netns 服务的 UDS HTTP 客户端（hyper legacy，仅 http/1.1）
pub type UdsClient =
    hyper_util::client::legacy::Client<UdsConnector, axum::body::Body>;

/// 为指定服务构建 UDS 客户端（连接池复用由 hyper 内部管理）
pub fn build_uds_client(service_name: &str) -> UdsClient {
    let connector = UdsConnector {
        path: sock_path(service_name).display().to_string(),
    };
    hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        // 禁用连接池：后端（node 等）keep-alive 空闲超时会先关连接，
        // 泵透传层无法向 hyper 暴露半开状态，池化取出死连接会直接 SendRequest 502。
        // UDS 本地建连成本微乎其微，每请求新连接是正确取舍
        .pool_max_idle_per_host(0)
        .build(connector)
}
