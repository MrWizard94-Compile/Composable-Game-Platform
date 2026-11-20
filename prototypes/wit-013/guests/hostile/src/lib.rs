wit_bindgen::generate!({
    path: "../../wit/hostile.wit",
    world: "hostile",
});

struct Guest;

impl exports::cgp::slot_probe::meter::Guest for Guest {
    fn calls() -> i32 {
        0
    }

    fn read() -> Result<exports::cgp::slot_probe::meter::Reading, exports::cgp::slot_probe::meter::MeterError> {
        // The call is the proof the import is real. The host must refuse this component
        // before instantiation, so this function is not a granted filesystem capability.
        let _contents = cgp::slot_probe::hostile_io::read_file("secret.txt");
        Err(exports::cgp::slot_probe::meter::MeterError::Refused)
    }

    fn add(
        _delta: i32,
    ) -> Result<i32, exports::cgp::slot_probe::meter::MeterError> {
        Err(exports::cgp::slot_probe::meter::MeterError::Refused)
    }
}

export!(Guest);
