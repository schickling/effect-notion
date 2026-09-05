use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::File,
    io::{self, Read},
    path::Path,
};

pub const SUPPORT_CAPABILITY_CONTRACT: &str = "effect-utils/buck2-support-tools/v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityManifest {
    closure_identity: String,
    /// The projected transitive `/nix/store` requisite set of the realization.
    ///
    /// This is the sandbox read allowlist, so the tool re-derives the producer's
    /// invariant instead of trusting it: strictly sorted, unique, canonical
    /// `/nix/store/<basename>` paths that include the tool's own closure.
    closure_store_paths: Vec<String>,
    content_digest: String,
    execution_platform: String,
    executable_store_path: String,
    protocol: String,
    runtime_contract: String,
    schema: String,
    tool_id: String,
}

fn verify_closure_store_paths(manifest: &CapabilityManifest) -> ToolResult<()> {
    let canonical = |value: &str| {
        value
            .strip_prefix("/nix/store/")
            .is_some_and(|basename| !basename.is_empty() && !basename.contains('/'))
    };
    let ordered = manifest
        .closure_store_paths
        .windows(2)
        .all(|pair| pair[0] < pair[1]);
    if manifest.closure_store_paths.is_empty()
        || !ordered
        || !manifest
            .closure_store_paths
            .iter()
            .all(|value| canonical(value.as_str()))
    {
        return Err(ToolError::new(
            "BUCK2_CAPABILITY_CLOSURE",
            "capability closure paths are not a canonical sorted store-path set",
        ));
    }
    if !manifest
        .closure_store_paths
        .iter()
        .any(|value| value == &manifest.closure_identity)
    {
        return Err(ToolError::new(
            "BUCK2_CAPABILITY_CLOSURE",
            "capability closure omits its own realization",
        ));
    }
    Ok(())
}

pub fn verify_execution_capability(
    manifest_path: &Path,
    actual_tool_id: &str,
    actual_protocol: &str,
    actual_runtime_contract: &str,
) -> ToolResult<()> {
    let bytes = std::fs::read(manifest_path).map_err(|error| {
        io_error(
            "BUCK2_CAPABILITY_MANIFEST",
            "could not read capability manifest",
            error,
        )
    })?;
    let manifest: CapabilityManifest = serde_json::from_slice(&bytes).map_err(|error| {
        ToolError::new(
            "BUCK2_CAPABILITY_MANIFEST",
            format!("invalid capability manifest: {error}"),
        )
    })?;
    let actual_platform = format!("{}-{}", env::consts::ARCH, env::consts::OS);
    let resolved = env::current_exe()
        .map_err(|error| {
            io_error(
                "BUCK2_CAPABILITY_EXECUTABLE",
                "could not resolve current executable",
                error,
            )
        })?
        .canonicalize()
        .map_err(|error| {
            io_error(
                "BUCK2_CAPABILITY_EXECUTABLE",
                "could not resolve executable identity",
                error,
            )
        })?;
    let executable_bytes = std::fs::read(&resolved).map_err(|error| {
        io_error(
            "BUCK2_CAPABILITY_EXECUTABLE",
            "could not read current executable",
            error,
        )
    })?;
    verify_capability_manifest(
        &manifest,
        &resolved,
        &executable_bytes,
        &actual_platform,
        actual_tool_id,
        actual_protocol,
        actual_runtime_contract,
    )
}

fn verify_capability_manifest(
    manifest: &CapabilityManifest,
    resolved: &Path,
    executable_bytes: &[u8],
    actual_platform: &str,
    actual_tool_id: &str,
    actual_protocol: &str,
    actual_runtime_contract: &str,
) -> ToolResult<()> {
    if manifest.schema != SUPPORT_CAPABILITY_CONTRACT
        || manifest.execution_platform != actual_platform
        || manifest.tool_id != actual_tool_id
    {
        return Err(ToolError::new(
            "BUCK2_CAPABILITY_IDENTITY",
            "execution capability identity or native platform does not match",
        ));
    }
    if manifest.protocol != actual_protocol || manifest.runtime_contract != actual_runtime_contract
    {
        return Err(ToolError::new(
            "BUCK2_CAPABILITY_PROTOCOL",
            "execution capability protocol does not match the tool",
        ));
    }
    if !resolved.starts_with("/nix/store/") {
        return Err(ToolError::new(
            "BUCK2_CAPABILITY_EXECUTABLE",
            "support tool must resolve to an immutable Nix store executable",
        ));
    }
    if resolved != Path::new(&manifest.executable_store_path) {
        return Err(ToolError::new(
            "BUCK2_CAPABILITY_EXECUTABLE",
            "executable does not match the exact store target",
        ));
    }
    if !resolved.starts_with(&manifest.closure_identity) {
        return Err(ToolError::new(
            "BUCK2_CAPABILITY_EXECUTABLE",
            "executable is outside the declared Nix closure identity",
        ));
    }
    verify_closure_store_paths(manifest)?;
    if sha256_bytes(executable_bytes) != manifest.content_digest {
        return Err(ToolError::new(
            "BUCK2_CAPABILITY_DIGEST",
            "executable byte digest does not match capability manifest",
        ));
    }
    Ok(())
}

pub type ToolResult<T> = Result<T, ToolError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "error[{}]: {}", self.code, self.message)
    }
}

impl std::error::Error for ToolError {}

pub fn io_error(code: &'static str, context: &str, error: io::Error) -> ToolError {
    ToolError::new(code, format!("{context}: {error}"))
}

pub fn sha256_bytes(value: &[u8]) -> String {
    hex(&Sha256::digest(value))
}

pub fn sha256_file(path: &Path) -> ToolResult<String> {
    let mut source = File::open(path).map_err(|error| {
        io_error(
            "BUCK2_IO",
            &format!("could not read {}", path.display()),
            error,
        )
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|error| io_error("BUCK2_IO", "could not hash input", error))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex(&digest.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(DIGITS[(byte >> 4) as usize] as char);
        encoded.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    encoded
}

pub fn sha256_sri(hex_digest: &str) -> ToolResult<String> {
    if !is_sha256(hex_digest) {
        return Err(ToolError::new(
            "BUCK2_INVALID_DIGEST",
            "sha256 must contain exactly 64 lowercase hexadecimal characters",
        ));
    }
    let bytes = (0..hex_digest.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex_digest[index..index + 2], 16).expect("validated hex"))
        .collect::<Vec<_>>();
    Ok(format!("sha256-{}", STANDARD.encode(bytes)))
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn canonical_json<T: Serialize>(value: &T) -> ToolResult<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value).map_err(|error| {
        ToolError::new(
            "BUCK2_JSON",
            format!("could not serialize canonical JSON: {error}"),
        )
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn pretty_json<T: Serialize>(value: &T) -> ToolResult<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        ToolError::new("BUCK2_JSON", format!("could not serialize JSON: {error}"))
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn normalized_relative(value: &str, field: &str) -> ToolResult<String> {
    if value.is_empty() {
        return Err(ToolError::new(
            "BUCK2_INVALID_PATH",
            format!("{field} must be a non-empty string"),
        ));
    }
    if value.bytes().any(|byte| byte < 32 || byte == 127) {
        return Err(ToolError::new(
            "BUCK2_INVALID_PATH",
            format!("{field} must not contain control characters"),
        ));
    }
    if value.starts_with('/') || value.contains('\\') {
        return Err(ToolError::new(
            "BUCK2_INVALID_PATH",
            format!("{field} must be a normalized relative path: {value:?}"),
        ));
    }
    if value
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(ToolError::new(
            "BUCK2_INVALID_PATH",
            format!("{field} must not traverse and must be a normalized relative path: {value:?}"),
        ));
    }
    Ok(value.to_owned())
}

pub fn safe_text(value: &str, field: &str) -> ToolResult<String> {
    if value.is_empty() || value.bytes().any(|byte| byte < 32 || byte == 127) {
        return Err(ToolError::new(
            "BUCK2_INVALID_TEXT",
            format!("{field} must be non-empty and contain no control characters"),
        ));
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_contract_is_posix_relative_and_normalized() {
        assert_eq!(normalized_relative("bin/tool", "path").unwrap(), "bin/tool");
        for bad in [
            "",
            "/bin/tool",
            "bin/../tool",
            "bin//tool",
            "./bin/tool",
            "bin\\tool",
        ] {
            assert!(
                normalized_relative(bad, "path").is_err(),
                "accepted {bad:?}"
            );
        }
        for byte in (0_u8..=31).chain(std::iter::once(127)) {
            let bad = format!("bin/{}tool", char::from(byte));
            assert!(
                normalized_relative(&bad, "path").is_err(),
                "accepted byte {byte}"
            );
        }
    }

    #[test]
    fn runtime_text_accepts_names_without_ascii_controls() {
        for value in ["tool/v1", "native-executable/v1", "x86_64-linux", "gnu"] {
            assert_eq!(safe_text(value, "runtime name").unwrap(), value);
        }
    }

    #[test]
    fn runtime_text_rejects_every_ascii_control() {
        for byte in (0_u8..=31).chain(std::iter::once(127)) {
            let bad = format!("native{}runtime", char::from(byte));
            assert!(
                safe_text(&bad, "runtime name").is_err(),
                "accepted byte {byte}"
            );
        }
    }

    fn capability() -> CapabilityManifest {
        CapabilityManifest {
            closure_identity: "/nix/store/00000000000000000000000000000000-tool".into(),
            closure_store_paths: vec![
                "/nix/store/00000000000000000000000000000000-tool".into(),
                "/nix/store/11111111111111111111111111111111-glibc".into(),
            ],
            content_digest: sha256_bytes(b"tool-bytes"),
            execution_platform: "x86_64-linux".into(),
            executable_store_path: "/nix/store/00000000000000000000000000000000-tool/bin/tool"
                .into(),
            protocol: "tool/v1".into(),
            runtime_contract: "native-executable/v1".into(),
            schema: SUPPORT_CAPABILITY_CONTRACT.into(),
            tool_id: "tool".into(),
        }
    }

    #[test]
    fn capability_attestation_rejects_every_closure_lie() {
        let path = Path::new("/nix/store/00000000000000000000000000000000-tool/bin/tool");
        let verify = |manifest: &CapabilityManifest| {
            verify_capability_manifest(
                manifest,
                path,
                b"tool-bytes",
                "x86_64-linux",
                "tool",
                "tool/v1",
                "native-executable/v1",
            )
        };
        // A projected closure is the sandbox read allowlist, so an empty,
        // unsorted, duplicated, non-normalized, or self-omitting set must fail
        // before the tool runs rather than work because the host store is
        // visible.
        let mut empty = capability();
        empty.closure_store_paths.clear();
        let mut unsorted = capability();
        unsorted.closure_store_paths.reverse();
        let mut duplicated = capability();
        duplicated.closure_store_paths =
            vec![duplicated.closure_identity.clone(), duplicated.closure_identity.clone()];
        let mut nested = capability();
        nested.closure_store_paths =
            vec![nested.executable_store_path.clone(), nested.closure_identity.clone()];
        let mut relative = capability();
        relative.closure_store_paths =
            vec!["nix/store/00000000000000000000000000000000-tool".into()];
        let mut bare = capability();
        bare.closure_store_paths = vec!["/nix/store/".into()];
        let mut foreign = capability();
        foreign.closure_store_paths =
            vec!["/nix/store/22222222222222222222222222222222-other".into()];
        for broken in [empty, unsorted, duplicated, nested, relative, bare, foreign] {
            assert_eq!(
                verify(&broken).unwrap_err().code,
                "BUCK2_CAPABILITY_CLOSURE",
                "accepted closure {:?}",
                broken.closure_store_paths
            );
        }
        assert!(verify(&capability()).is_ok());
    }

    #[test]
    fn capability_attestation_rejects_every_identity_lie() {
        let path = Path::new("/nix/store/00000000000000000000000000000000-tool/bin/tool");
        let verify =
            |manifest: &CapabilityManifest, bytes: &[u8], platform: &str, protocol: &str| {
                verify_capability_manifest(
                    manifest,
                    path,
                    bytes,
                    platform,
                    "tool",
                    protocol,
                    "native-executable/v1",
                )
            };
        assert!(verify(&capability(), b"tool-bytes", "x86_64-linux", "tool/v1").is_ok());
        assert_eq!(
            verify(&capability(), b"replacement", "x86_64-linux", "tool/v1")
                .unwrap_err()
                .code,
            "BUCK2_CAPABILITY_DIGEST"
        );
        assert_eq!(
            verify(&capability(), b"tool-bytes", "aarch64-linux", "tool/v1")
                .unwrap_err()
                .code,
            "BUCK2_CAPABILITY_IDENTITY"
        );
        assert_eq!(
            verify(&capability(), b"tool-bytes", "x86_64-linux", "tool/v2")
                .unwrap_err()
                .code,
            "BUCK2_CAPABILITY_PROTOCOL"
        );
        let mut digest_lie = capability();
        digest_lie.content_digest = "0".repeat(64);
        assert_eq!(
            verify(&digest_lie, b"tool-bytes", "x86_64-linux", "tool/v1")
                .unwrap_err()
                .code,
            "BUCK2_CAPABILITY_DIGEST"
        );
        let mut target_lie = capability();
        target_lie.executable_store_path.push_str("-replacement");
        assert_eq!(
            verify(&target_lie, b"tool-bytes", "x86_64-linux", "tool/v1")
                .unwrap_err()
                .code,
            "BUCK2_CAPABILITY_EXECUTABLE"
        );
        let ambient = Path::new("/tmp/tool");
        assert_eq!(
            verify_capability_manifest(
                &capability(),
                ambient,
                b"tool-bytes",
                "x86_64-linux",
                "tool",
                "tool/v1",
                "native-executable/v1"
            )
            .unwrap_err()
            .code,
            "BUCK2_CAPABILITY_EXECUTABLE"
        );
    }
}
