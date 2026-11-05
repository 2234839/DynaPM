use std::time::Duration;
use tokio::net::TcpStream;

#[tokio::main]
async fn main() {
    let addr = "127.0.0.1:3901";
    let r = tokio::time::timeout(Duration::from_millis(100), TcpStream::connect(addr)).await;
    match r {
        Ok(Ok(_)) => println!("TCP 3901 通"),
        Ok(Err(e)) => println!("TCP 3901 连接错误: {e}"),
        Err(_) => println!("TCP 3901 超时"),
    }
}
