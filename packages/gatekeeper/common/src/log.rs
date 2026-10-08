//! Plain line logging in the gateway's format (`<ISO time> [<name>] <level>: <message>`). Never log passwords.
use std::io::Write;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static NAME: OnceLock<String> = OnceLock::new();

/// The name shown in each line (once, at startup).
pub fn set_name(name: &str) {
    let _ = NAME.set(name.to_string());
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian (Howard Hinnant's civil_from_days).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

fn timestamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = now.as_secs() as i64;
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let rest = seconds.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60,
        now.subsec_millis()
    )
}

fn line(level: &str, message: &str) {
    let name = NAME.get().map(String::as_str).unwrap_or("login");
    let text = format!("{} [{name}] {level}: {message}\n", timestamp());
    if level == "info" {
        let _ = std::io::stdout().lock().write_all(text.as_bytes());
    } else {
        let _ = std::io::stderr().lock().write_all(text.as_bytes());
    }
}

pub fn info(message: &str) {
    line("info", message)
}

pub fn warn(message: &str) {
    line("warn", message)
}

pub fn error(message: &str) {
    line("error", message)
}

#[cfg(test)]
mod tests {
    #[test]
    fn dates() {
        assert_eq!(super::civil_from_days(0), (1970, 1, 1));
        assert_eq!(super::civil_from_days(20_733), (2026, 10, 7));
        assert_eq!(super::civil_from_days(11_016), (2000, 2, 29));
    }
}
