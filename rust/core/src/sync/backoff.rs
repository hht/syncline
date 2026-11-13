//! Backoff delay calculation after disconnect or error: attempt n waits randomly between
//! 0 and `min(MAX_DELAY, BASE_DELAY * 2^n)` milliseconds (full jitter); when cloud provides
//! a reconnect window (spread, sent by broadcast shards based on active connection count),
//! spreads out across at least that window; proactively reconnects between 1 and 4 minutes
//! before token expiry.
//! What it should not know: how to connect or what to do once connected.
//! @see <https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/> (full jitter)

pub const BASE_DELAY: f64 = 1000.0;
pub const MAX_DELAY: f64 = 30_000.0;
/// Proactively reconnects at least this long before token expiry, with random jitter up to `RENEW_SPREAD`
pub const RENEW_BEFORE: f64 = 60_000.0;
pub const RENEW_SPREAD: f64 = 180_000.0;

/// Random float in [0, 1) provided by caller: mobile uses Rust RNG, wasm uses JS `Math.random`, tests use stub
pub type Random = Box<dyn FnMut() -> f64>;

#[derive(Default)]
pub struct Backoff {
    /// Consecutive failure count
    attempt: i32,
    /// Cloud-provided reconnect window in milliseconds
    spread: f64,
}

impl Backoff {
    /// Computes delay before attempt
    pub fn of(&self, attempt: i32, random: &mut Random) -> f64 {
        random() * self.spread.max(MAX_DELAY.min(BASE_DELAY * 2f64.powi(attempt)))
    }

    /// Computes next delay after another failure and increments attempt count
    pub fn next(&mut self, random: &mut Random) -> f64 {
        let delay = self.of(self.attempt, random);
        self.attempt = self.attempt.saturating_add(1);
        delay
    }

    /// Resets backoff count upon progress
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    /// Makes the next delay the longest one, until reset
    pub fn exhaust(&mut self) {
        self.attempt = i32::MAX;
    }

    /// Records cloud-provided reconnect window
    pub fn spread(&mut self, spread: f64) {
        self.spread = spread;
    }

    /// Computes delay before proactive token renewal reconnect given `expires_in` milliseconds remaining; returns None if 4 minutes or
    /// less remain: the reconnect could be due at once, and again on every connection the same or an equally short token opens, so such
    /// a token is kept until the cloud closes its connection as expired
    pub fn renewal(expires_in: f64, random: &mut Random) -> Option<f64> {
        (expires_in > RENEW_BEFORE + RENEW_SPREAD).then(|| expires_in - RENEW_BEFORE - random() * RENEW_SPREAD)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grows_to_the_cap_and_honours_the_spread() {
        let mut one: Random = Box::new(|| 1.0);
        let mut backoff = Backoff::default();
        let delays: Vec<f64> = (0..7).map(|_| backoff.next(&mut one)).collect();
        assert_eq!(delays, [1000.0, 2000.0, 4000.0, 8000.0, 16_000.0, 30_000.0, 30_000.0]);
        backoff.reset();
        backoff.spread(90_000.0);
        assert_eq!(backoff.next(&mut one), 90_000.0);
    }

    #[test]
    fn renews_between_one_and_four_minutes_before_expiry() {
        let mut half: Random = Box::new(|| 0.5);
        assert_eq!(Backoff::renewal(3_600_000.0, &mut half), Some(3_450_000.0));
        // With 4 minutes or less left the latest draw is due at once: not renewed
        let mut one: Random = Box::new(|| 1.0);
        assert_eq!(Backoff::renewal(240_000.0, &mut one), None);
        assert_eq!(Backoff::renewal(241_000.0, &mut one), Some(1000.0));
    }
}
