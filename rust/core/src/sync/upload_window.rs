//! Upload delay (`uploadDelay`): a local write opens a fixed window, which later writes do not extend (as Replicache `pushDelay`); until it
//! closes, pushes stop before its first write, so writes made meanwhile upload together while earlier ones upload at once. Not persisted.
//! What it should not know: sockets, batches, confirmations, or why the window closes early.
//! @see <https://doc.replicache.dev/api/interfaces/ReplicacheOptions#pushdelay>

use crate::sync::instructions::{Out, Timer};
use crate::upload_queue::Mutation;

/// Open window: its timer and the client and id of its first write.
struct Open {
    timer: u32,
    client: String,
    id: i64,
}

pub struct UploadWindow {
    delay: Option<f64>,
    open: Option<Open>,
}

impl UploadWindow {
    /// `delay` in milliseconds, a positive integer the app checked (openSyncline); none uploads at once.
    pub fn new(delay: Option<f64>) -> Self {
        UploadWindow { delay, open: None }
    }

    /// A local write (client and id) committed on `channel`: opens a window at it unless one is open or no delay is set.
    pub fn wrote(&mut self, out: &mut Out, channel: &str, (client, id): (String, i64)) {
        let Some(delay) = self.delay.filter(|_| self.open.is_none()) else {
            return;
        };
        let timer = out.schedule(
            Timer::Upload {
                channel: channel.to_owned(),
            },
            delay,
        );
        self.open = Some(Open { timer, client, id });
    }

    /// Closes the window (its timer fired, or the caller closes it early); returns whether one was open.
    pub fn close(&mut self, out: &mut Out) -> bool {
        let Some(open) = self.open.take() else { return false };
        out.cancel(Some(open.timer));
        true
    }

    /// Drops the pending mutations from the window's first write on.
    pub fn cut(&self, pending: &mut Vec<Mutation>) {
        let Some(open) = &self.open else { return };
        if let Some(at) = pending
            .iter()
            .position(|mutation| mutation.client == open.client && mutation.id == open.id)
        {
            pending.truncate(at);
        }
    }
}
