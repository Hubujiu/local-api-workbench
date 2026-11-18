use base64::{engine::general_purpose::STANDARD, Engine};
use dm_rust::{proto::types::*, Column, ConnectOptions, Connection, Value};
use serde::Deserialize;
use serde_json::{json, Map, Value as Json};
use std::{
    io::{self, Read, Write},
    time::Duration,
};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_database_precision_and_binary() {
        let d = "12345678901234567890.125"
            .parse::<dm_rust::Decimal>()
            .unwrap();
        assert_eq!(
            cell(Value::Decimal(d)).unwrap(),
            json!("12345678901234567890.125")
        );
        assert_eq!(
            cell(Value::BigInt(i64::MAX)).unwrap(),
            json!("9223372036854775807")
        );
        assert_eq!(
            cell(Value::Bytes(vec![0, 1, 255].into())).unwrap(),
            json!({"type":"blob","base64":"AAH/"})
        );
        assert!(cell(Value::Double(1.2)).is_err());
    }
    #[test]
    fn binds_stay_typed_and_separate_from_sql() {
        assert_eq!(
            parameter(json!("a'b")).unwrap(),
            Value::String("a'b".into())
        );
        assert_eq!(parameter(json!(5)).unwrap(), Value::BigInt(5));
        assert_eq!(parameter(Json::Null).unwrap(), Value::Null);
        assert!(parameter(json!(true)).is_err());
        assert!(parameter(json!({"sql":"name"})).is_err());
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    host: String,
    port: u16,
    user: String,
    password: String,
    ca: String,
    #[serde(default, rename = "clientCert")]
    client_cert: String,
    #[serde(default, rename = "clientKey")]
    client_key: String,
    #[serde(default, rename = "clientRoot")]
    client_root: String,
    sql: String,
    columns: Vec<String>,
    parameters: Vec<Json>,
}

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const OUTPUT_LIMIT: usize = 1024 * 1024;

fn parameter(v: Json) -> Result<Value> {
    Ok(match v {
        Json::Null => Value::Null,
        Json::String(s) => Value::String(s),
        Json::Number(n) => Value::BigInt(n.as_i64().ok_or("invalid integer")?),
        _ => return Err("invalid bind".into()),
    })
}

fn check_columns(fields: &[Column], names: &[String]) -> Result<()> {
    if fields.len() != names.len()
        || fields.iter().zip(names).any(|(f, name)| {
            f.name != *name
                || !matches!(
                    f.col_type,
                    CHAR | VARCHAR
                        | VARCHAR2
                        | TINYINT
                        | SMALLINT
                        | INT
                        | BIGINT
                        | DECIMAL
                        | BINARY
                        | VARBINARY
                )
        })
    {
        return Err("unsupported projection".into());
    }
    Ok(())
}

fn cell(v: Value) -> Result<Json> {
    Ok(match v {
        Value::Null => Json::Null,
        Value::String(s) => Json::String(s),
        Value::TinyInt(n) => json!(n.to_string()),
        Value::SmallInt(n) => json!(n.to_string()),
        Value::Int(n) => json!(n.to_string()),
        Value::BigInt(n) => json!(n.to_string()),
        Value::Decimal(n) => json!(n.to_string()),
        Value::Bytes(b) => json!({"type":"blob", "base64":STANDARD.encode(b)}),
        _ => return Err("unsupported value".into()),
    })
}

async fn run(request: Request) -> Result<Vec<u8>> {
    let mut opts = ConnectOptions::new(&request.host, request.port, request.user, request.password);
    opts.read_only = true;
    opts.tls_server_name = Some(request.host);
    opts.tls_ca_pem = request.ca.into_bytes();
    opts.tls_client_cert = request.client_cert.into_bytes();
    opts.tls_client_key = request.client_key.into_bytes();
    opts.tls_client_root = request.client_root.into_bytes();
    opts.login_encrypt = false; // The driver requires verified full-session TLS before LOGIN.
    opts.app_name = "Local API Workbench".into();
    opts.connect_timeout = Duration::from_secs(2);
    opts.request_timeout = Some(Duration::from_secs(2));
    opts.fetch_size = 100;
    let args = request
        .parameters
        .into_iter()
        .map(parameter)
        .collect::<Result<Vec<_>>>()?;
    let mut db = Connection::connect(&opts).await?;
    db.begin().await?;
    db.execute("SET TRANSACTION READ ONLY", &[]).await?;
    let work = async {
        let statement = db.prepare(&request.sql).await?;
        check_columns(&statement.columns, &request.columns)?;
        let result = db.query(&request.sql, &args).await?;
        check_columns(&result.columns, &request.columns)?;
        let mut rows = Vec::new();
        let mut bytes = 0;
        for row in result.rows {
            if row.values.len() != request.columns.len() || rows.len() >= 1000 {
                return Err("row limit or shape".into());
            }
            let mut obj = Map::new();
            for (name, value) in request.columns.iter().zip(row.values) {
                obj.insert(name.clone(), cell(value)?);
            }
            bytes += serde_json::to_vec(&obj)?.len() + 1;
            if bytes > OUTPUT_LIMIT {
                return Err("large result".into());
            }
            rows.push(obj);
        }
        let output = serde_json::to_vec(&json!({
            "columns": request.columns, "rows": rows, "truncated": false, "limit": 1000,
        }))?;
        if output.len() > OUTPUT_LIMIT {
            return Err("large result".into());
        }
        Ok(output)
    }
    .await;
    let rollback = db.rollback().await;
    db.close().await?;
    rollback?;
    work
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let work = async {
        let mut bytes = Vec::new();
        io::stdin().take(524289).read_to_end(&mut bytes)?;
        if bytes.len() > 524288 {
            return Err("large input".into());
        }
        let output = run(serde_json::from_slice(&bytes)?).await?;
        io::stdout().write_all(&output)?;
        Ok::<_, Box<dyn std::error::Error>>(())
    };
    if !matches!(
        tokio::time::timeout(Duration::from_secs(6), work).await,
        Ok(Ok(()))
    ) {
        std::process::exit(1);
    }
}
