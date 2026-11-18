// Modified for Local API Workbench: use only the explicit in-memory trust roots.
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

pub enum Stream {
    /// 升级 TLS 期间的占位（不可读写）
    #[allow(dead_code)]
    Empty,
    Plain(TcpStream),
    #[cfg(feature = "tls")]
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

impl AsyncRead for Stream {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Empty => Poll::Ready(Err(io::Error::new(io::ErrorKind::NotConnected, "stream unavailable"))),
            Stream::Plain(s) => Pin::new(s).poll_read(cx, buf),
            #[cfg(feature = "tls")]
            Stream::Tls(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Stream::Empty => Poll::Ready(Err(io::Error::new(io::ErrorKind::NotConnected, "stream unavailable"))),
            Stream::Plain(s) => Pin::new(s).poll_write(cx, buf),
            #[cfg(feature = "tls")]
            Stream::Tls(s) => Pin::new(s).poll_write(cx, buf),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Empty => Poll::Ready(Err(io::Error::new(io::ErrorKind::NotConnected, "stream unavailable"))),
            Stream::Plain(s) => Pin::new(s).poll_flush(cx),
            #[cfg(feature = "tls")]
            Stream::Tls(s) => Pin::new(s).poll_flush(cx),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Empty => Poll::Ready(Err(io::Error::new(io::ErrorKind::NotConnected, "stream unavailable"))),
            Stream::Plain(s) => Pin::new(s).poll_shutdown(cx),
            #[cfg(feature = "tls")]
            Stream::Tls(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

#[cfg(feature = "tls")]
pub(crate) mod tls {
    use crate::conn::error::{Error, Result};
    use std::sync::Arc;
    pub fn connector(pem: &[u8]) -> Result<tokio_rustls::TlsConnector> {
        let mut roots = rustls::RootCertStore::empty();
        for cert in rustls_pemfile::certs(&mut &pem[..]) {
            roots.add(cert.map_err(|e| Error::Tls(e.to_string()))?)
                .map_err(|e| Error::Tls(e.to_string()))?;
        }
        if roots.is_empty() { return Err(Error::Tls("an explicit CA is required".into())); }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions().map_err(|e| Error::Tls(e.to_string()))?
            .with_root_certificates(roots).with_no_client_auth();
        Ok(tokio_rustls::TlsConnector::from(Arc::new(config)))
    }
}
