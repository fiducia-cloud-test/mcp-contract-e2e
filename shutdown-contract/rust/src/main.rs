#![forbid(unsafe_code)]

use axum::{routing::get, Router};
use server_shutdown_contract::{supervise, Config};
use tokio::{net::TcpListener, sync::oneshot};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .json()
        .init();

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    info!(
        address = %listener.local_addr()?,
        "shutdown-contract fixture listening"
    );
    let app = Router::new().route("/", get(|| async { "ok" }));
    let (graceful_tx, graceful_rx) = oneshot::channel();
    let server = async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = graceful_rx.await;
            })
            .await
    };

    let outcome = supervise(server, graceful_tx, Config::default()).await?;
    info!(
        forced = outcome.forced,
        trigger = %outcome.trigger,
        "fixture stopped"
    );
    Ok(())
}
