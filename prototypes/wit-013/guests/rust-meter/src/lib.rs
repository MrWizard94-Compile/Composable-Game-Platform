use std::cell::UnsafeCell;

wit_bindgen::generate!({
    path: "../../wit/slot-probe.wit",
    world: "probe",
});

struct Slot(UnsafeCell<Meter>);
unsafe impl Sync for Slot {}

struct Meter {
    calls: i32,
    value: i32,
    next_pass: i32,
    live: i32,
}

static SLOT: Slot = Slot(UnsafeCell::new(Meter {
    calls: 0,
    value: 0,
    next_pass: 0,
    live: 0,
}));

fn with_meter<T>(body: impl FnOnce(&mut Meter) -> T) -> T {
    // One guest instance is single-threaded. The cell is not shared across threads.
    unsafe { body(&mut *SLOT.0.get()) }
}

struct Guest;

struct Ticket {
    id: String,
    module: String,
    composition: String,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        with_meter(|meter| meter.live -= 1);
    }
}

fn label() -> &'static str {
    "rust-meter"
}

impl exports::cgp::slot_probe::meter::Guest for Guest {
    fn calls() -> i32 {
        with_meter(|meter| meter.calls)
    }

    fn read() -> Result<exports::cgp::slot_probe::meter::Reading, exports::cgp::slot_probe::meter::MeterError> {
        with_meter(|meter| {
            meter.calls += 1;
            Ok(exports::cgp::slot_probe::meter::Reading {
                value: meter.value,
                label: label().to_string(),
            })
        })
    }

    fn add(delta: i32) -> Result<i32, exports::cgp::slot_probe::meter::MeterError> {
        with_meter(|meter| {
            meter.calls += 1;
            match meter.value.checked_add(delta) {
                Some(next) => {
                    meter.value = next;
                    Ok(next)
                }
                None => Err(exports::cgp::slot_probe::meter::MeterError::Overflow),
            }
        })
    }
}

impl exports::cgp::slot_probe::registry::Guest for Guest {
    fn contributions() -> Vec<exports::cgp::slot_probe::registry::Contribution> {
        let row = |id: &str, order: i32| exports::cgp::slot_probe::registry::Contribution {
            id: id.to_string(),
            order,
            label: label().to_string(),
        };
        vec![row("rust-early", 1), row("shared", 1), row("alpha", 20)]
    }
}

impl exports::cgp::slot_probe::passes::GuestPass for Ticket {
    fn id(&self) -> String {
        self.id.clone()
    }

    fn module(&self) -> String {
        self.module.clone()
    }

    fn composition(&self) -> String {
        self.composition.clone()
    }
}

impl exports::cgp::slot_probe::passes::Guest for Guest {
    type Pass = Ticket;

    fn live() -> i32 {
        with_meter(|meter| meter.live)
    }

    fn issue(module_id: String, composition: String) -> exports::cgp::slot_probe::passes::Pass {
        let id = with_meter(|meter| {
            let id = format!("rust-{}", meter.next_pass);
            meter.next_pass += 1;
            meter.live += 1;
            id
        });
        exports::cgp::slot_probe::passes::Pass::new(Ticket {
            id,
            module: module_id,
            composition,
        })
    }

    fn peek(ticket: exports::cgp::slot_probe::passes::PassBorrow<'_>) -> String {
        let ticket = ticket.get::<Ticket>();
        format!("{}|{}|{}", ticket.id, ticket.module, ticket.composition)
    }

    fn consume(ticket: exports::cgp::slot_probe::passes::Pass) -> Result<String, String> {
        let ticket = ticket.into_inner::<Ticket>();
        Ok(format!(
            "consumed:{}|{}|{}",
            ticket.id, ticket.module, ticket.composition
        ))
    }
}

export!(Guest);
