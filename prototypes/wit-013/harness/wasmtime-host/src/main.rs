use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use wasmtime::component::{Component, Linker, ResourceAny};
use wasmtime::{Engine, Store};

wasmtime::component::bindgen!({
    path: "../../wit/slot-probe.wit",
    world: "probe",
});

struct Session {
    store: Store<()>,
    bindings: Probe,
    handles: HashMap<u32, ResourceAny>,
    next: u32,
}

fn reply(value: Value) {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, &value).ok();
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

fn fail(error: impl ToString) -> Value {
    json!({ "ok": false, "error": error.to_string() })
}

fn imports_of(path: &str) -> Result<Vec<String>> {
    let engine = Engine::default();
    let component = Component::from_file(&engine, path)?;
    let ty = component.component_type();
    let mut names = Vec::new();
    for (name, _item) in ty.imports(&engine) {
        names.push(name.to_string());
    }
    names.sort();
    Ok(names)
}

fn load(path: &str) -> Result<(Session, u128)> {
    let engine = Engine::default();
    let component = Component::from_file(&engine, path)?;
    let linker = Linker::new(&engine);
    let mut store = Store::new(&engine, ());
    let started = Instant::now();
    let bindings = Probe::instantiate(&mut store, &component, &linker)?;
    let instantiate_us = started.elapsed().as_micros();
    Ok((
        Session {
            store,
            bindings,
            handles: HashMap::new(),
            next: 1,
        },
        instantiate_us,
    ))
}

fn meter(session: &Session) -> exports::cgp::slot_probe::meter::Guest {
    session.bindings.cgp_slot_probe_meter().clone()
}

fn registry(session: &Session) -> exports::cgp::slot_probe::registry::Guest {
    session.bindings.cgp_slot_probe_registry().clone()
}

fn passes(session: &Session) -> exports::cgp::slot_probe::passes::Guest {
    session.bindings.cgp_slot_probe_passes().clone()
}

fn handle<'a>(session: &'a Session, id: u32) -> Result<ResourceAny> {
    session
        .handles
        .get(&id)
        .copied()
        .ok_or_else(|| anyhow!("unknown handle {id}"))
}

fn command(session: &mut Option<Session>, message: &Value) -> Result<Value> {
    let cmd = message.get("cmd").and_then(Value::as_str).unwrap_or("");
    match cmd {
        "imports" => {
            let path = message
                .get("path")
                .and_then(Value::as_str)
                .context("path")?;
            Ok(json!({ "ok": true, "imports": imports_of(path)? }))
        }
        "load" => {
            let path = message
                .get("path")
                .and_then(Value::as_str)
                .context("path")?;
            let (loaded, instantiate_us) = load(path)?;
            *session = Some(loaded);
            Ok(json!({ "ok": true, "instantiateUs": instantiate_us }))
        }
        "try-instantiate" => {
            let path = message
                .get("path")
                .and_then(Value::as_str)
                .context("path")?;
            match load(path) {
                Ok(_) => Ok(json!({ "ok": true, "instantiated": true })),
                Err(error) => Ok(json!({
                    "ok": true,
                    "instantiated": false,
                    "error": format!("{error:#}")
                })),
            }
        }
        "calls" => {
            let session = session.as_mut().context("not loaded")?;
            let value = meter(session).call_calls(&mut session.store)?;
            Ok(json!({ "ok": true, "value": value }))
        }
        "read" => {
            let session = session.as_mut().context("not loaded")?;
            match meter(session).call_read(&mut session.store)? {
                Ok(reading) => Ok(json!({
                    "ok": true,
                    "value": reading.value,
                    "label": reading.label
                })),
                Err(error) => Ok(json!({
                    "ok": true,
                    "guestOk": false,
                    "error": format!("{error:?}").to_lowercase()
                })),
            }
        }
        "add" => {
            let session = session.as_mut().context("not loaded")?;
            let delta = message
                .get("delta")
                .and_then(Value::as_i64)
                .context("delta")? as i32;
            match meter(session).call_add(&mut session.store, delta)? {
                Ok(value) => Ok(json!({ "ok": true, "value": value })),
                Err(error) => Ok(json!({
                    "ok": true,
                    "guestOk": false,
                    "error": format!("{error:?}").to_lowercase()
                })),
            }
        }
        "contributions" => {
            let session = session.as_mut().context("not loaded")?;
            let rows = registry(session).call_contributions(&mut session.store)?;
            let contributions: Vec<_> = rows
                .into_iter()
                .map(|row| json!({ "id": row.id, "order": row.order, "label": row.label }))
                .collect();
            Ok(json!({ "ok": true, "contributions": contributions }))
        }
        "live" => {
            let session = session.as_mut().context("not loaded")?;
            let value = passes(session).call_live(&mut session.store)?;
            Ok(json!({ "ok": true, "value": value }))
        }
        "issue" => {
            let session = session.as_mut().context("not loaded")?;
            let module_id = message
                .get("moduleId")
                .and_then(Value::as_str)
                .context("moduleId")?
                .to_string();
            let composition = message
                .get("composition")
                .and_then(Value::as_str)
                .context("composition")?
                .to_string();
            let resource = passes(session).call_issue(&mut session.store, &module_id, &composition)?;
            let id = session.next;
            session.next += 1;
            session.handles.insert(id, resource);
            Ok(json!({ "ok": true, "handle": id }))
        }
        "peek" => {
            let id = message.get("handle").and_then(Value::as_u64).context("handle")? as u32;
            let session = session.as_mut().context("not loaded")?;
            let resource = handle(session, id)?;
            let text = passes(session).call_peek(&mut session.store, resource)?;
            Ok(json!({ "ok": true, "value": text }))
        }
        "consume" => {
            let id = message.get("handle").and_then(Value::as_u64).context("handle")? as u32;
            let session = session.as_mut().context("not loaded")?;
            let resource = handle(session, id)?;
            let consumed = passes(session).call_consume(&mut session.store, resource)?;
            let text = match consumed {
                Ok(text) => text,
                Err(error) => return Ok(json!({ "ok": true, "guestOk": false, "error": error })),
            };
            session.handles.remove(&id);
            Ok(json!({ "ok": true, "value": text }))
        }
        "drop" => {
            let id = message.get("handle").and_then(Value::as_u64).context("handle")? as u32;
            let session = session.as_mut().context("not loaded")?;
            let resource = handle(session, id)?;
            resource.resource_drop(&mut session.store)?;
            session.handles.remove(&id);
            Ok(json!({ "ok": true }))
        }
        "bench" => {
            let n = message.get("n").and_then(Value::as_u64).context("n")? as u32;
            let session = session.as_mut().context("not loaded")?;
            let started = Instant::now();
            let mut last = 0;
            for _ in 0..n {
                last = meter(session)
                    .call_add(&mut session.store, 1)?
                    .map_err(|error| anyhow!("{error:?}"))?;
            }
            Ok(json!({
                "ok": true,
                "n": n,
                "elapsedUs": started.elapsed().as_micros(),
                "value": last
            }))
        }
        "rss" => {
            let text = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
            let rss = text
                .lines()
                .find_map(|line| line.strip_prefix("VmRSS:"))
                .and_then(|rest| rest.split_whitespace().next())
                .and_then(|kb| kb.parse::<u64>().ok())
                .unwrap_or(0);
            Ok(json!({ "ok": true, "rssKb": rss }))
        }
        "shutdown" => {
            *session = None;
            Ok(json!({ "ok": true }))
        }
        other => Ok(fail(format!("unknown command {other}"))),
    }
}

fn main() {
    let mut session = None;
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                reply(fail(error));
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                reply(fail(error));
                continue;
            }
        };
        match command(&mut session, &message) {
            Ok(value) => reply(value),
            Err(error) => reply(fail(format!("{error:#}"))),
        }
    }
}
