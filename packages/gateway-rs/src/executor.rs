//! Bash 命令执行器（与 Bun 版 command-executor.ts 语义对齐）
//!
//! 等待语义：以 bash 进程退出为准（拿 exit code），stdout/stderr 管道后台
//! drain 后尽力收集。不能用 wait_with_output（等 pipe EOF）：start 类命令
//! 常见 `nohup server &` 后台拉起，服务进程会把 stdio fd 持有在管道上，
//! EOF 永不到来，导致启动命令挂到超时被误杀。

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// 命令执行结果
pub struct CommandResult {
    /// 标准输出
    pub stdout: String,
    /// 标准错误输出
    pub stderr: String,
    /// 退出码（超时被杀时为 124）
    pub exit_code: i32,
    /// 本次命令的进程组 id（process_group(0)，可用于整组 SIGKILL 兑底）
    pub pgid: u32,
}

/// 命令执行选项
#[derive(Clone)]
pub struct CommandOptions {
    /// 工作目录
    pub cwd: Option<String>,
    /// 环境变量（叠加在进程环境之上）
    pub env: Option<HashMap<String, String>>,
    /// 超时时间（毫秒），超时 kill 进程组
    pub timeout_ms: Option<u64>,
    /// 是否收集 stdout/stderr；false 时 stdio 直接 null，无管道无 drain，
    /// start 类长驻命令快路径用（省去退出后的 drain 等待，且天然无 pipe-EOF 问题）
    pub collect_output: bool,
    /// startExec 直启时的日志文件（stdout/stderr 追加重定向）
    pub log_file: Option<String>,
}

impl Default for CommandOptions {
    fn default() -> Self {
        Self {
            cwd: None,
            env: None,
            timeout_ms: None,
            collect_output: true,            log_file: None,        }
    }
}

/// 杀掉整个进程组（负 pid 即 pgid；bash 经 process_group(0) 成为组长）
/// 纯 libc 直调（无 fork+wait），微秒级返回，可在任意上下文安全调用
pub fn kill_process_group(pgid: u32) {
    signal_process_group(pgid, libc::SIGKILL);
}

/** 对整个进程组发送指定信号（负 pid 即 pgid；SIGTERM 优雅 / SIGKILL 强杀） */
pub fn signal_process_group(pgid: u32, sig: i32) {
    unsafe { libc::kill(-(pgid as i32), sig) };
}

/// 执行 bash 命令并返回结果（等 bash 退出；超时 kill 进程组返回 124）
pub async fn execute(command: &str, options: &CommandOptions) -> CommandResult {
    let mut cmd = Command::new("bash");
    cmd.arg("-c").arg(command);
    if let Some(cwd) = &options.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &options.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    // drop Child 时连带终止（兜底）；主动清理走 kill_process_group
    cmd.kill_on_drop(true);
    cmd.process_group(0);

    let spawned = if options.collect_output {
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
    } else {
        cmd.stdout(Stdio::null()).stderr(Stdio::null()).spawn()
    };
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            return CommandResult {
                stdout: String::new(),
                stderr: e.to_string(),
                exit_code: 1,
                pgid: 0,
            };
        }
    };
    let pgid = child.id().unwrap_or(0);

    // 管道后台 drain：防写满阻塞 bash，同时尽力收集输出
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let drain = tokio::spawn(async move {
        let mut stdout_buf = Vec::new();
        let mut stderr_buf = Vec::new();
        if let Some(p) = stdout_pipe.as_mut() {
            let _ = p.read_to_end(&mut stdout_buf).await;
        }
        if let Some(p) = stderr_pipe.as_mut() {
            let _ = p.read_to_end(&mut stderr_buf).await;
        }
        (stdout_buf, stderr_buf)
    });

    let timeout = Duration::from_millis(options.timeout_ms.unwrap_or(30_000));
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            drain.abort();
            return CommandResult {
                stdout: String::new(),
                stderr: e.to_string(),
                exit_code: 1,
                pgid,
            };
        }
        Err(_) => {
            // 超时：kill 整个进程组（bash + 孙进程），返回 124 对齐 GNU timeout
            kill_process_group(pgid);
            let _ = tokio::time::timeout(Duration::from_secs(1), drain).await;
            return CommandResult {
                stdout: String::new(),
                stderr: "命令执行超时".to_string(),
                exit_code: 124,
                pgid,
            };
        }
    };

    // bash 已退出：给 drain 一小段时间收尾输出（孙进程持有 pipe 时立即放弃，不阻塞）
    // 免输出模式（collect_output=false）没有管道，直接返回
    let (stdout_buf, stderr_buf) = if options.collect_output {
        match tokio::time::timeout(Duration::from_millis(50), drain).await {
            Ok(Ok((o, e))) => (o, e),
            _ => (Vec::new(), Vec::new()),
        }
    } else {
        drain.abort();
        (Vec::new(), Vec::new())
    };

    CommandResult {
        stdout: String::from_utf8_lossy(&stdout_buf).to_string(),
        stderr: String::from_utf8_lossy(&stderr_buf).to_string(),
        exit_code: status.code().unwrap_or(1),
        pgid,
    }
}

/// 检查命令执行是否成功（退出码为 0）
pub async fn check(command: &str, options: &CommandOptions) -> bool {
    execute(command, &options).await.exit_code == 0
}

/// 直接 fork/exec 启动长驻进程（跳过 bash，stdio 走 null，无管道无 drain）
/// 返回进程组 id（process_group(0)，stop 超时 SIGKILL 兑底用）
/// 进程脱离网关生命周期独立运行（kill_on_drop(false)，由状态机 pgid 兑底管理）
pub async fn spawn_direct(args: &[String], options: &CommandOptions) -> Result<u32, String> {
    let Some(program) = args.first() else {
        return Err("startExec 参数为空".to_string());
    };
    let mut cmd = Command::new(program);
    cmd.args(&args[1..]);
    if let Some(cwd) = &options.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &options.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    cmd.kill_on_drop(false);
    cmd.process_group(0);
    // logFile 配置时 stdout/stderr 追加重定向到文件（等价 bash 的 >> log 2>&1）
    // 文件 open 放阻塞线程池：async 上下文里的同步文件 IO 会钉死 tokio worker
    let log_stdio = match &options.log_file {
        Some(p) => {
            let p = p.clone();
            tokio::task::spawn_blocking(move || {
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&p)
                    .ok()
                    .and_then(|f| {
                        let dup = f.try_clone().ok()?;
                        Some((Stdio::from(f), Stdio::from(dup)))
                    })
            })
            .await
            .unwrap_or(None)
        }
        None => None,
    };
    match log_stdio {
        Some((out, err)) => {
            cmd.stdout(out);
            cmd.stderr(err);
        }
        None => {
            cmd.stdout(Stdio::null());
            cmd.stderr(Stdio::null());
        }
    }
    cmd.stdin(Stdio::null());
    match cmd.spawn() {
        Ok(child) => Ok(child.id().unwrap_or(0)),
        Err(e) => Err(format!("启动失败: {e}")),
    }
}
