//! Portable-path owner for the desktop shell.
//!
//! `DesktopPaths` derives the shell's on-disk locations from the executable's
//! directory (portable extraction root) and the user profile roots that the
//! runtime resolves at startup. Writable state never derives from the
//! extraction directory: it is a managed, replace-on-update location.

use std::fmt;
use std::path::{Path, PathBuf};

use tauri::Manager;

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

/// Reasons `DesktopPaths::from_roots` can fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopPathsError {
    /// The executable path has no parent directory.
    MissingExecutableParent,
}

impl fmt::Display for DesktopPathsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DesktopPathsError::MissingExecutableParent => {
                write!(f, "executable path has no parent directory")
            }
        }
    }
}

impl std::error::Error for DesktopPathsError {}

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
    /// resolved user directories.
    pub fn from_environment(app: &tauri::AppHandle) -> Result<Self, DesktopPathsError> {
        let exe = std::env::current_exe().map_err(|_| DesktopPathsError::MissingExecutableParent)?;
        Self::from_roots(&exe, &dirs_home_dir(app), &dirs_local_app_data(app))
    }
}

fn dirs_home_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .home_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn dirs_local_app_data(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .local_data_dir()
        .unwrap_or_else(|_| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
        })
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
        assert_eq!(result, Err(DesktopPathsError::MissingExecutableParent));
    }
}
