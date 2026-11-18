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
    use rustls::client::ResolvesClientCert;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    #[derive(Debug)]
    struct ClientIdentity {
        resolver: Arc<dyn ResolvesClientCert>,
        selected: AtomicBool,
    }
    impl ResolvesClientCert for ClientIdentity {
        fn resolve(&self, issuers: &[&[u8]], schemes: &[rustls::SignatureScheme]) -> Option<Arc<rustls::sign::CertifiedKey>> {
            let identity = self.resolver.resolve(issuers, schemes);
            self.selected.store(identity.is_some(), Ordering::Relaxed);
            identity
        }
        fn has_certs(&self) -> bool { self.resolver.has_certs() }
    }
    pub async fn connect(tcp: tokio::net::TcpStream, name: rustls::pki_types::ServerName<'static>,
        pem: &[u8], cert: &[u8], key: &[u8]) -> Result<tokio_rustls::client::TlsStream<tokio::net::TcpStream>> {
        let mut roots = rustls::RootCertStore::empty();
        for cert in rustls_pemfile::certs(&mut &pem[..]) {
            roots.add(cert.map_err(|e| Error::Tls(e.to_string()))?)
                .map_err(|e| Error::Tls(e.to_string()))?;
        }
        if roots.is_empty() { return Err(Error::Tls("an explicit CA is required".into())); }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let builder = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions().map_err(|e| Error::Tls(e.to_string()))?
            .with_root_certificates(roots);
        let mut config = if cert.is_empty() && key.is_empty() {
            builder.with_no_client_auth()
        } else {
            let chain = rustls_pemfile::certs(&mut &cert[..]).collect::<std::io::Result<Vec<_>>>()?;
            let private = rustls_pemfile::private_key(&mut &key[..])?
                .ok_or_else(|| Error::Tls("missing client key".into()))?;
            builder.with_client_auth_cert(chain, private)
                .map_err(|_| Error::Tls("invalid client identity".into()))?
        };
        // A configured identity must participate in this handshake before LOGIN.
        let identity = Arc::new(ClientIdentity {
            resolver: config.client_auth_cert_resolver.clone(),
            selected: AtomicBool::new(false),
        });
        config.client_auth_cert_resolver = identity.clone();
        let stream = tokio_rustls::TlsConnector::from(Arc::new(config)).connect(name, tcp)
            .await.map_err(|e| Error::Tls(e.to_string()))?;
        if !cert.is_empty() && !identity.selected.load(Ordering::Relaxed) {
            return Err(Error::Tls("server did not request the configured client certificate".into()));
        }
        Ok(stream)
    }
}
