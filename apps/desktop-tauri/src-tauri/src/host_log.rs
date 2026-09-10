//! Host log files for the desktop supervisor (Windows-only).
//!
//! `DesktopLog` records the supervisor's own lifecycle events with
//! timestamps; `RotatingLog` appends child stdout/stderr lines, rotating to a
//! single predecessor file once the current file exceeds a byte budget. The
//! retained set is exactly two files: the current file plus one rotated copy.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use windows::Win32::System::SystemInformation::GetLocalTime;

/// The machine-local civil time as an ISO-like `YYYY-MM-DDTHH:MM:SS` stamp.
fn local_now() -> String {
    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    )
}

/// A log that appends timestamped supervisor lifecycle events.
#[derive(Debug, Clone)]
pub struct DesktopLog {
    path: PathBuf,
}

impl DesktopLog {
    /// Open an append-only event log at `path`.
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Append one timestamped `[kind] detail` line. Best-effort: a failed write
    /// is surfaced on stderr rather than failing the supervised operation.
    pub fn event(&self, kind: &str, detail: &str) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let line = format!("{} [{kind}] {detail}", local_now());
        match OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut f| writeln!(f, "{line}"))
        {
            Ok(()) => {}
            Err(error) => eprintln!("desktop log write failed: {error}"),
        }
    }
}

/// A single-host log that rotates to `<path>.1` once it exceeds `max_size`; the
/// current file plus one rotated copy is the whole retained set (2 files).
///
/// Rotation renames the current file to `<path>.1`, discarding any older copy,
/// then reopens a fresh current file. Only the current file and its newest
/// rotated predecessor are kept.
#[derive(Debug)]
pub struct RotatingLog {
    path: PathBuf,
    file: Option<File>,
    max_size: u64,
}

impl RotatingLog {
    /// Open (lazily, on first append) a rotating log at `path`.
    pub fn new(path: PathBuf, max_size: u64) -> Self {
        Self {
            path,
            file: None,
            max_size,
        }
    }

    /// Append `line` plus a newline, rotating first when the current file would
    /// exceed `max_size`.
    pub fn append(&mut self, line: &[u8]) -> std::io::Result<()> {
        if self.file.is_none() {
            if let Some(parent) = self.path.parent() {
                fs::create_dir_all(parent)?;
            }
            self.file = Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)?,
            );
        }
        let current = self.file.as_ref().expect("log file is open").metadata()?.len();
        if current.saturating_add(line.len() as u64) > self.max_size {
            self.rotate()?;
        }
        let file = self.file.as_mut().expect("log file is open");
        file.write_all(line)?;
        file.write_all(b"\n")?;
        file.flush()
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        self.file = None;
        let rotated = PathBuf::from(format!("{}.1", self.path.to_string_lossy()));
        let _ = fs::remove_file(&rotated);
        fs::rename(&self.path, &rotated)?;
        self.file = Some(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?,
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn rotation_keeps_the_current_file_and_one_predecessor() {
        use std::env::temp_dir;
        let dir = temp_dir().join(format!("dsh-rotate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("host.log");
        let mut log = RotatingLog::new(path.clone(), 10);
        // 10-byte budget: each append of a larger line forces rotation.
        log.append(b"0123456789abc").unwrap();
        log.append(b"x").unwrap();
        log.append(b"0123456789abc").unwrap();
        assert!(path.exists(), "current file must exist");
        assert!(
            PathBuf::from(format!("{}.1", path.to_string_lossy())).exists(),
            "one rotated copy must be retained"
        );
        // Only two files are ever on disk.
        let files = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .count();
        assert_eq!(files, 2, "expected exactly the current file plus one rotated copy");
        let _ = fs::remove_dir_all(&dir);
    }
}
