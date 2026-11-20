wit_bindgen::generate!({
    path: "../../wit/async-probe.wit",
    world: "async-probe",
});

struct Guest;

impl exports::cgp::async_probe::ping::Guest for Guest {
    async fn tick() -> Result<String, String> {
        Ok("pong".to_string())
    }
}

export!(Guest);
