//! Strict wire types for the Host runtime-identity endpoint.
//!
//! These mirror the Task 1 TypeScript protocol constants exactly and reject
//! anything that does not round-trip as the current, compatible host so the
//! shell never attaches to an unverified listener.

use serde::Deserialize;

/// The product name served by the DeepSeek Harness web host.
pub const DSH_RUNTIME_PRODUCT: &str = "deepseek-harness";
/// The desktop protocol version the shell can attach to.
pub const DSH_DESKTOP_PROTOCOL: u32 = 1;
/// The exact identity route the shell probes.
pub const DSH_RUNTIME_IDENTITY_PATH: &str = "/api/runtime.identity";

/// Where the host's data home directory resolves: the default `~/.dsh` or a
/// `$DSH_HOME` override.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HomeKind {
    /// The host runs from the default `~/.dsh` home.
    Default,
    /// The host runs against a `$DSH_HOME` override.
    Custom,
}

/// The exact identity served at `DSH_RUNTIME_IDENTITY_PATH`. Field names follow
/// the wire (`camelCase`) and any unknown field fails deserialization, so a
/// future protocol bump is detected here instead of being silently attached.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeIdentity {
    /// The product name; must equal `DSH_RUNTIME_PRODUCT`.
    pub product: String,
    /// The desktop protocol version; must equal `DSH_DESKTOP_PROTOCOL`.
    pub desktop_protocol: u32,
    /// Bundle/package version. Must be non-empty.
    pub version: String,
    /// Anonymous per-process id. Must be non-empty.
    pub instance_id: String,
    /// Where the host's data home resolves.
    pub home_kind: HomeKind,
}

/// Report whether an identity is the current shell-compatible host.
///
/// A compatible identity is the deepseek-harness product at protocol version 1
/// running from its default home, with a non-empty version and instance id.
pub fn compatible(identity: &RuntimeIdentity) -> bool {
    identity.product == DSH_RUNTIME_PRODUCT
        && identity.desktop_protocol == DSH_DESKTOP_PROTOCOL
        && identity.home_kind == HomeKind::Default
        && !identity.version.is_empty()
        && !identity.instance_id.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(version: &str, instance_id: &str) -> RuntimeIdentity {
        RuntimeIdentity {
            product: DSH_RUNTIME_PRODUCT.into(),
            desktop_protocol: DSH_DESKTOP_PROTOCOL,
            version: version.into(),
            instance_id: instance_id.into(),
            home_kind: HomeKind::Default,
        }
    }

    #[test]
    fn a_default_identity_is_compatible() {
        assert!(compatible(&identity("0.1.0", "uuid")));
    }

    #[test]
    fn wrong_product_is_incompatible() {
        let mut it = identity("0.1.0", "uuid");
        it.product = "other".into();
        assert!(!compatible(&it));
    }

    #[test]
    fn protocol_two_is_incompatible() {
        let mut it = identity("0.1.0", "uuid");
        it.desktop_protocol = 2;
        assert!(!compatible(&it));
    }

    #[test]
    fn a_custom_home_is_incompatible() {
        let mut it = identity("0.1.0", "uuid");
        it.home_kind = HomeKind::Custom;
        assert!(!compatible(&it));
    }

    #[test]
    fn an_empty_version_or_instance_is_incompatible() {
        assert!(!compatible(&identity("", "uuid")));
        assert!(!compatible(&identity("0.1.0", "")));
    }

    #[test]
    fn denies_unknown_fields_and_accepts_camel_case() {
        use serde_json::json;
        let ok: RuntimeIdentity = serde_json::from_value(
            json!({"product":"deepseek-harness","desktopProtocol":1,"version":"v","instanceId":"i","homeKind":"default"}),
        )
        .unwrap();
        assert!(compatible(&ok));

        let mut extra = json!({"product":"deepseek-harness","desktopProtocol":1,"version":"v","instanceId":"i","homeKind":"default"});
        extra["futureField"] = json!(true);
        assert!(serde_json::from_value::<RuntimeIdentity>(extra).is_err());
    }
}
