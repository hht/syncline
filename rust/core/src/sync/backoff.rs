//! 断了、出错之后过多久再试：第 n 次在 0 到 min(上限, 基数 × 2^n) 毫秒之间随机等（全抖动），
//! 云端给了重连的窗口（spread，广播分片按连着的设备数给）就至少摊开到它；身份到期前 1 到 4 分钟之间随机挑一刻自己重连。
//! 不该知道的：怎么连、连上之后做什么。
//! @see <https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/>（full jitter）

pub const BASE_DELAY: f64 = 1000.0;
pub const MAX_DELAY: f64 = 30_000.0;
/// 身份到期前至少这么久就自己重连，在这之前再随机提前至多这么久
const RENEW_BEFORE: f64 = 60_000.0;
const RENEW_SPREAD: f64 = 180_000.0;

/// 0 到 1 之间的随机数（外面给：手机上 Rust 自取，wasm 里是 JS 的 `Math.random`，测试里是替身）
pub type Random = Box<dyn FnMut() -> f64>;

#[derive(Default)]
pub struct Backoff {
    /// 连着失败了几次
    attempt: i32,
    /// 云端给的重连窗口（毫秒）
    spread: f64,
}

impl Backoff {
    /// 第 attempt 次重试前等多久
    pub fn of(&self, attempt: i32, random: &mut Random) -> f64 {
        random() * self.spread.max(MAX_DELAY.min(BASE_DELAY * 2f64.powi(attempt)))
    }

    /// 又失败了一次：这次等多久（之后再失败等得更久）
    pub fn next(&mut self, random: &mut Random) -> f64 {
        let delay = self.of(self.attempt, random);
        self.attempt = self.attempt.saturating_add(1);
        delay
    }

    /// 有进展了：从头算
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    /// 记下云端给的重连窗口
    pub fn spread(&mut self, spread: f64) {
        self.spread = spread;
    }

    /// 身份还有 `expires_in` 毫秒到期：过多久自己换 token 重连；不到 1 分钟就不重连（取 token 的一方来不及给新的）
    pub fn renewal(expires_in: f64, random: &mut Random) -> Option<f64> {
        (expires_in > RENEW_BEFORE).then(|| (expires_in - RENEW_BEFORE - random() * RENEW_SPREAD).max(0.0))
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
        assert_eq!(Backoff::renewal(60_000.0, &mut half), None);
        assert_eq!(Backoff::renewal(3_600_000.0, &mut half), Some(3_450_000.0));
        assert_eq!(Backoff::renewal(61_000.0, &mut half), Some(0.0));
    }
}
