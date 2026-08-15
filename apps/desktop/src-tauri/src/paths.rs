//! Portable-path owner for the desktop shell.
//!
//! `DesktopPaths` derives the shell's on-disk locations from the executable's
//! directory (portable extraction root) and the user profile roots that the
//! runtime resolves at startup. Writable state never derives from the
//! extraction directory: it is a managed, replace-on-update location.

use std::path::{Path, PathBuf};

use tauri::Manager;
use thiserror::Error;

/// Path set derived from the shell's process roots.
///
/// - `node` sits under the portable extraction root next to the executable.
/// - `home` and `cwd` come from the user profile directory.
/// - `logs` sits under the machine-local application-data directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopPaths {
    /// The embedded Node runtime executable, relative to the extraction root.
    pub node: PathBuf,
    /// The per-user state directory (`.dsh`).
    pub home: PathBuf,
    /// The process working directory (the user profile).
    pub cwd: PathBuf,
    /// The per-user log directory.
    pub logs: PathBuf,
}

/// Reasons `DesktopPaths` derivation can fail.
#[derive(Debug, Error)]
pub enum DesktopPathsError {
    /// The executable path has no parent directory.
    #[error("executable path has no parent directory")]
    MissingExecutableParent,
    /// The running process's executable could not be resolved.
    #[error("the desktop shell executable could not be resolved: {0}")]
    ExecutableUnresolved(#[source] std::io::Error),
    /// The user home directory could not be resolved.
    #[error("the user home directory could not be resolved")]
    HomeUnresolved,
    /// Neither the machine-local app-data directory nor `LOCALAPPDATA` could be resolved.
    #[error("the machine-local app-data directory could not be resolved")]
    LocalAppDataUnresolved,
}

impl DesktopPaths {
    /// Derive `DesktopPaths` from process roots passed explicitly, so the
    /// mapping is pure and unit-testable.
    ///
    /// Rejects `exe` with no parent directory; the extraction directory is
    /// required to locate `node`.
    pub fn from_roots(exe: &Path, home_dir: &Path, local_app_data: &Path) -> Result<Self, DesktopPathsError> {
        let extraction = match exe.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            // `Path::parent` yields an empty component for a bare filename,
            // which still gives us no directory to derive a portable root from.
            _ => return Err(DesktopPathsError::MissingExecutableParent),
        };
        let product = "DeepSeek Harness";
        Ok(Self {
            node: extraction.join("node").join("node.exe"),
            home: home_dir.join(".dsh"),
            cwd: home_dir.to_path_buf(),
            logs: local_app_data.join(product).join("logs"),
        })
    }

    /// Derive `DesktopPaths` from the running process and the Tauri app's
    /// resolved user directories. Fails loud rather than degrading to the
    /// current directory when a user root cannot be resolved.
    pub fn from_environment(app: &tauri::AppHandle) -> Result<Self, DesktopPathsError> {
        let exe = std::env::current_exe().map_err(DesktopPathsError::ExecutableUnresolved)?;
        let home = app.path().home_dir().map_err(|_| DesktopPathsError::HomeUnresolved)?;
        let local_app_data = app
            .path()
            .local_data_dir()
            .map_err(|_| DesktopPathsError::LocalAppDataUnresolved)?;
        Self::from_roots(&exe, &home, &local_app_data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_resources_are_relative_to_the_executable() {
        let exe = Path::new(r"C:\Portable\DeepSeek Harness\DeepSeek Harness.exe");
        let paths = DesktopPaths::from_roots(
            exe,
            Path::new(r"C:\Users\Ada"),
            Path::new(r"C:\Users\Ada\AppData\Local"),
        )
        .unwrap();
        assert_eq!(paths.node, Path::new(r"C:\Portable\DeepSeek Harness\node\node.exe"));
        assert_eq!(paths.home, Path::new(r"C:\Users\Ada\.dsh"));
        assert_eq!(paths.cwd, Path::new(r"C:\Users\Ada"));
        assert_eq!(paths.logs, Path::new(r"C:\Users\Ada\AppData\Local\DeepSeek Harness\logs"));
    }

    #[test]
    fn rejects_a_missing_executable_parent() {
        let result = DesktopPaths::from_roots(
            Path::new("only-a-filename.exe"),
            Path::new(r"C:\Users\Ada"),
            Path::new(r"C:\Users\Ada\AppData\Local"),
        );
        assert!(matches!(result, Err(DesktopPathsError::MissingExecutableParent)));
    }
}
