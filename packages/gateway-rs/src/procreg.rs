//! 服务进程组登记簿（pgid registry）
//!
//! 网关拉起服务后把进程组 id 写入磁盘（内存缓存加速读），
//! 关停/回收时直接对进程组发信号，不依赖字符串匹配（pkill -f）。
//! 网关重启后内存态丢失，从磁盘恢复，簿记不丢。
//!
//! 文件位置：与用户配置同目录的 pgids/ 下，每服务一个文件（内容即 pgid）。
//! 文件残留（进程已死但文件还在）无害：信号发送前先校验进程组是否存活。

use std::path::PathBuf;
use std::sync::Mutex;

/** 内存缓存：服务名 -> pgid（磁盘是事实源，缓存只是避免每次 read） */
static CACHE: Mutex<Option<std::collections::HashMap<String, u32>>> = Mutex::new(None);

/** 簿记目录初始化（config 加载后调用一次；后续读写都走这里） */
pub fn init_dir(dir: Option<PathBuf>) {
    let dir = dir.unwrap_or_else(|| std::env::temp_dir().join("dynapm-pgids"));
    let _ = std::fs::create_dir_all(&dir);
    std::env::set_var("DYNAPM_PGID_DIR", &dir);
}

fn pgid_dir() -> PathBuf {
    std::env::var("DYNAPM_PGID_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("dynapm-pgids"))
}

/** 服务名净化（仅作文件名成分，过滤路径分隔符防注入） */
fn safe_name(service: &str) -> String {
    service
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn pgid_file(service: &str) -> PathBuf {
    pgid_dir().join(safe_name(service))
}

/** 彻底关停（paused）标志文件：用户明确 disable 的服务，重启后不得被按需拉起复活 */
pub fn paused_file(service: &str) -> PathBuf {
    pgid_dir().join(format!("{}.paused", safe_name(service)))
}

/** 读取服务的彻底关停标志（磁盘事实源） */
pub fn is_paused(service: &str) -> bool {
    pgid_file(service).with_file_name(format!("{}.paused", safe_name(service))).exists()
}

/** 写入/清除彻底关停标志 */
pub fn set_paused(service: &str, paused: bool) {
    let f = paused_file(service);
    if paused {
        let _ = std::fs::write(&f, b"1");
    } else {
        let _ = std::fs::remove_file(&f);
    }
}

/** 进程组是否存活（kill 0 探测，ESRCH = 不存在） */
pub fn group_alive(pgid: u32) -> bool {
    // 安全性：kill(-pgid) 只影响登记过的进程组；pgid 0/1 不可信，直接拒
    if pgid < 2 {
        return false;
    }
    unsafe { libc::kill(-(pgid as i32), 0) == 0 }
}

/** 登记服务进程组（写磁盘 + 更新缓存；服务实际由网关 spawn 的 bash 组长持有 pgid） */
pub fn register(service: &str, pgid: u32) {
    if pgid < 2 {
        return;
    }
    let _ = std::fs::write(pgid_file(service), pgid.to_string());
    if let Ok(mut cache) = CACHE.lock() {
        cache.get_or_insert_with(Default::default).insert(service.to_string(), pgid);
    }
}

/** 注销（服务确认死亡后清理簿记） */
pub fn unregister(service: &str) {
    let _ = std::fs::remove_file(pgid_file(service));
    if let Ok(mut cache) = CACHE.lock() {
        if let Some(m) = cache.as_mut() {
            m.remove(service);
        }
    }
}

/** 查询服务登记的 pgid（缓存 > 磁盘）；不存在或进程组已死返回 None */
pub fn lookup(service: &str) -> Option<u32> {
    let pgid = {
        let cache = CACHE.lock().ok()?;
        cache
            .as_ref()
            .and_then(|m| m.get(service).copied())
            .or_else(|| {
                std::fs::read_to_string(pgid_file(service))
                    .ok()
                    .and_then(|s| s.trim().parse::<u32>().ok())
            })?
    };
    group_alive(pgid).then_some(pgid)
}

/**
 * 端口反查收编：占用上游端口但不是网关拉起的进程（用户手动起的 dev server、
 * 网关重启前拉的服务），通过 /proc/net/tcp + /proc/<pid>/fd 的 socket inode
 * 反查监听进程，取其 pgid 收编登记——之后关停即可直接杀组
 */
pub fn adopt_by_port(service: &str, port: u16) -> Option<u32> {
    let inode = listen_inode(port)?;
    let pid = find_pid_holding_socket(&inode)?;
    let pgid = std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|s| parse_pgid_from_stat(&s))?;
    if pgid < 2 {
        return None;
    }
    register(service, pgid);
    Some(pgid)
}

/** /proc/net/tcp 中 LISTEN 状态端口的 socket inode（0.0.0. 与 127.0.0. 绑定都在其中） */
fn listen_inode(port: u16) -> Option<String> {
    let hex_port = format!("{:04X}", port);
    for f in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let content = std::fs::read_to_string(f).ok()?;
        for line in content.lines().skip(1) {
            let cols: Vec<&str> = line.split_whitespace().collect();
            // cols: [local_addr, rem_addr, st, ...] st=0A 即 LISTEN；inode 是第 10 列
            if cols.len() > 9 && cols[1].ends_with(&hex_port) && cols[3] == "0A" {
                return cols[9].to_string().into();
            }
        }
    }
    None
}

/** 扫描 /proc/<pid>/fd 找持有该 socket inode 的进程（同用户进程可读）。
 *  注意 /proc 下混有非 pid 目录（acpi/fs/irq...），parse 失败必须 continue，
 *  用 ? 早退会让整个反查静默失败（历史上就栽在这） */
fn find_pid_holding_socket(inode: &str) -> Option<u32> {
    let target = format!("socket:[{inode}]");
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let pid: u32 = match entry.file_name().to_string_lossy().parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let fd_dir = format!("/proc/{pid}/fd");
        if let Ok(fds) = std::fs::read_dir(&fd_dir) {
            for fd in fds.flatten() {
                if fd.path().read_link().map(|l| l.to_string_lossy() == target).unwrap_or(false) {
                    return Some(pid);
                }
            }
        }
    }
    None
}

/** /proc/<pid>/stat 第 5 列是 pgid（空格分隔需跳过 comm 字段里的括号） */
fn parse_pgid_from_stat(stat: &str) -> Option<u32> {
    let close = stat.rfind(')')?;
    let rest = stat[close + 1..].trim_start();
    // rest 从 state 字段（第 3 列）开始，pgid 是第 5 列 → 索引 2
    rest.split_whitespace().nth(2)?.parse().ok()
}
