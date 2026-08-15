//! Single-instance request queue for the desktop shell.
//!
//! A second process launch is killed by the single-instance plugin and its
//! callback fires on the first instance. When the main window already exists
//! the callback focuses it immediately. When a second launch arrives while
//! startup is still in progress (the window does not exist yet), the request
//! is remembered here and focused by the controller the moment the window is
//! created, so a user double-launch never silently drops.

/// A bounded record of a second launch seen before the main window existed.
#[derive(Debug, Default)]
pub struct InstanceQueue {
    pending: bool,
}

impl InstanceQueue {
    /// An empty queue: no second launch has arrived yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Remember that a second launch arrived during startup.
    pub fn remember(&mut self) {
        self.pending = true;
    }

    /// Take the pending flag, clearing it. Returns whether a second launch
    /// should focus the freshly created window.
    pub fn take_pending(&mut self) -> bool {
        let pending = self.pending;
        self.pending = false;
        pending
    }
}

#[cfg(test)]
mod tests {
    use super::InstanceQueue;

    #[test]
    fn a_second_instance_during_startup_is_remembered_once() {
        let mut queue = InstanceQueue::new();
        assert!(!queue.take_pending());
        queue.remember();
        assert!(queue.take_pending());
        assert!(!queue.take_pending());
    }
}
