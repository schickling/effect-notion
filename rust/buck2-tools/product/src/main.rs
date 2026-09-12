use buck2_tool_core::{
    canonical_json, normalized_relative, safe_text, sha256_bytes, sha256_sri,
    verify_execution_capability, ToolError, ToolResult,
};
use clap::{Args, Parser, Subcommand};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
use tar::{Builder, EntryType, Header};

#[derive(Parser)]
struct Cli {
    #[arg(long)]
    capability_manifest: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Package(PackageArgs),
}

#[derive(Args)]
struct PackageArgs {
    #[arg(long)]
    executable: PathBuf,
    #[arg(long)]
    support_tree: Option<PathBuf>,
    #[arg(long)]
    entrypoint: String,
    #[arg(long)]
    artifact: PathBuf,
    #[arg(long)]
    name: String,
    #[arg(long)]
    target: String,
    #[arg(long = "platform-os")]
    platform_os: String,
    #[arg(long = "platform-architecture")]
    platform_architecture: String,
    #[arg(long = "platform-abi")]
    platform_abi: String,
    #[arg(long = "runtime-contract")]
    runtime_contract: String,
    #[arg(long)]
    provenance: PathBuf,
    #[arg(long)]
    descriptor: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Provenance {
    schema: String,
    recipe: String,
    toolchain: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> ToolError {
    ToolError::new(code, message)
}

fn read_u16(bytes: &[u8], offset: usize, endian: Endian) -> ToolResult<u16> {
    let value: [u8; 2] = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| fail("BUCK2_PRODUCT_BINARY", "truncated native executable"))?
        .try_into()
        .unwrap();
    Ok(match endian {
        Endian::Little => u16::from_le_bytes(value),
        Endian::Big => u16::from_be_bytes(value),
    })
}

fn read_u32(bytes: &[u8], offset: usize, endian: Endian) -> ToolResult<u32> {
    let value: [u8; 4] = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| fail("BUCK2_PRODUCT_BINARY", "truncated native executable"))?
        .try_into()
        .unwrap();
    Ok(match endian {
        Endian::Little => u32::from_le_bytes(value),
        Endian::Big => u32::from_be_bytes(value),
    })
}

fn read_u64(bytes: &[u8], offset: usize, endian: Endian) -> ToolResult<u64> {
    let value: [u8; 8] = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| fail("BUCK2_PRODUCT_BINARY", "truncated native executable"))?
        .try_into()
        .unwrap();
    Ok(match endian {
        Endian::Little => u64::from_le_bytes(value),
        Endian::Big => u64::from_be_bytes(value),
    })
}

fn usize_from(value: u64) -> ToolResult<usize> {
    usize::try_from(value).map_err(|_| {
        fail(
            "BUCK2_PRODUCT_BINARY",
            "native executable offset is too large",
        )
    })
}

fn c_string(bytes: &[u8], offset: usize, field: &str) -> ToolResult<String> {
    let tail = bytes
        .get(offset..)
        .ok_or_else(|| fail("BUCK2_PRODUCT_BINARY", format!("invalid {field} offset")))?;
    let end = tail
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| fail("BUCK2_PRODUCT_BINARY", format!("unterminated {field}")))?;
    let value = std::str::from_utf8(&tail[..end])
        .map_err(|_| fail("BUCK2_PRODUCT_BINARY", format!("{field} is not UTF-8")))?;
    safe_text(value, field)
}

#[derive(Clone, Copy)]
enum Endian {
    Little,
    Big,
}

#[derive(Clone, Copy)]
struct ProgramHeader {
    kind: u32,
    offset: u64,
    virtual_address: u64,
    file_size: u64,
}

fn elf_identity(
    bytes: &[u8],
    architecture: &str,
    runtime_contract: &str,
) -> ToolResult<(Endian, &'static str, Vec<ProgramHeader>)> {
    if bytes.get(..4) != Some(b"\x7fELF") || bytes.get(4) != Some(&2) {
        return Err(fail(
            "BUCK2_PRODUCT_ELF",
            format!("{runtime_contract} requires an ELF64 executable"),
        ));
    }
    let endian = match bytes.get(5) {
        Some(1) => Endian::Little,
        Some(2) => Endian::Big,
        _ => return Err(fail("BUCK2_PRODUCT_ELF", "unsupported ELF byte order")),
    };
    let machine = match read_u16(bytes, 18, endian)? {
        62 => "x86_64",
        183 => "aarch64",
        value => {
            return Err(fail(
                "BUCK2_PRODUCT_ELF",
                format!("unsupported ELF machine: {value}"),
            ))
        }
    };
    if machine != architecture {
        return Err(fail(
            "BUCK2_PRODUCT_PLATFORM",
            format!("ELF machine {machine} does not match platform architecture {architecture}"),
        ));
    }
    let program_offset = usize_from(read_u64(bytes, 32, endian)?)?;
    let entry_size = usize::from(read_u16(bytes, 54, endian)?);
    let entry_count = usize::from(read_u16(bytes, 56, endian)?);
    if entry_size < 56 {
        return Err(fail(
            "BUCK2_PRODUCT_ELF",
            "invalid ELF64 program header size",
        ));
    }
    let mut headers = Vec::with_capacity(entry_count);
    for index in 0..entry_count {
        let offset =
            program_offset
                .checked_add(index.checked_mul(entry_size).ok_or_else(|| {
                    fail("BUCK2_PRODUCT_ELF", "ELF program header offset overflow")
                })?)
                .ok_or_else(|| fail("BUCK2_PRODUCT_ELF", "ELF program header offset overflow"))?;
        bytes
            .get(offset..offset + entry_size)
            .ok_or_else(|| fail("BUCK2_PRODUCT_ELF", "truncated ELF program headers"))?;
        headers.push(ProgramHeader {
            kind: read_u32(bytes, offset, endian)?,
            offset: read_u64(bytes, offset + 8, endian)?,
            virtual_address: read_u64(bytes, offset + 16, endian)?,
            file_size: read_u64(bytes, offset + 32, endian)?,
        });
    }
    Ok((endian, machine, headers))
}

fn elf_runtime(bytes: &[u8], architecture: &str) -> ToolResult<Value> {
    let (endian, machine, headers) = elf_identity(bytes, architecture, "elf-dynamic/v1")?;
    let interpreter_header = headers
        .iter()
        .find(|header| header.kind == 3)
        .ok_or_else(|| fail("BUCK2_PRODUCT_ELF", "ELF executable has no PT_INTERP"))?;
    let interpreter_offset = usize_from(interpreter_header.offset)?;
    let interpreter_size = usize_from(interpreter_header.file_size)?;
    let interpreter_bytes = bytes
        .get(interpreter_offset..interpreter_offset + interpreter_size)
        .ok_or_else(|| fail("BUCK2_PRODUCT_ELF", "truncated PT_INTERP"))?;
    if interpreter_bytes.last() != Some(&0)
        || interpreter_bytes[..interpreter_bytes.len() - 1].contains(&0)
    {
        return Err(fail("BUCK2_PRODUCT_ELF", "malformed PT_INTERP"));
    }
    let interpreter = std::str::from_utf8(&interpreter_bytes[..interpreter_bytes.len() - 1])
        .map_err(|_| fail("BUCK2_PRODUCT_ELF", "PT_INTERP is not UTF-8"))?;
    safe_text(interpreter, "ELF interpreter")?;

    let dynamic = headers
        .iter()
        .find(|header| header.kind == 2)
        .ok_or_else(|| fail("BUCK2_PRODUCT_ELF", "ELF executable has no PT_DYNAMIC"))?;
    let dynamic_offset = usize_from(dynamic.offset)?;
    let dynamic_size = usize_from(dynamic.file_size)?;
    let dynamic_bytes = bytes
        .get(dynamic_offset..dynamic_offset + dynamic_size)
        .ok_or_else(|| fail("BUCK2_PRODUCT_ELF", "truncated PT_DYNAMIC"))?;
    let mut string_table_address = None;
    let mut string_table_size = None;
    let mut needed_offsets = Vec::new();
    let mut version_needs_address = None;
    let mut version_needs_count = None;
    for entry in dynamic_bytes.chunks_exact(16) {
        let tag = read_u64(entry, 0, endian)?;
        let value = read_u64(entry, 8, endian)?;
        match tag {
            0 => break,
            1 => needed_offsets.push(value),
            5 => string_table_address = Some(value),
            10 => string_table_size = Some(value),
            15 | 29 => {
                return Err(fail(
                    "BUCK2_PRODUCT_ELF",
                    "elf-dynamic/v1 forbids DT_RPATH and DT_RUNPATH",
                ))
            }
            0x6fff_fffe => version_needs_address = Some(value),
            0x6fff_ffff => version_needs_count = Some(value),
            _ => {}
        }
    }
    let virtual_to_file = |address: u64| -> ToolResult<usize> {
        let segment = headers
            .iter()
            .filter(|header| header.kind == 1)
            .find(|header| {
                address >= header.virtual_address
                    && address < header.virtual_address.saturating_add(header.file_size)
            })
            .ok_or_else(|| {
                fail(
                    "BUCK2_PRODUCT_ELF",
                    "ELF virtual address is not file-backed",
                )
            })?;
        usize_from(segment.offset + (address - segment.virtual_address))
    };
    let strings_offset = virtual_to_file(
        string_table_address
            .ok_or_else(|| fail("BUCK2_PRODUCT_ELF", "PT_DYNAMIC has no DT_STRTAB"))?,
    )?;
    let strings_size = usize_from(
        string_table_size.ok_or_else(|| fail("BUCK2_PRODUCT_ELF", "PT_DYNAMIC has no DT_STRSZ"))?,
    )?;
    let strings = bytes
        .get(strings_offset..strings_offset + strings_size)
        .ok_or_else(|| fail("BUCK2_PRODUCT_ELF", "truncated ELF dynamic string table"))?;
    let mut needed = BTreeSet::new();
    for offset in needed_offsets {
        needed.insert(c_string(strings, usize_from(offset)?, "DT_NEEDED")?);
    }

    let mut versions = BTreeSet::new();
    match (version_needs_address, version_needs_count) {
        (Some(address), Some(count)) => {
            let mut record = virtual_to_file(address)?;
            for index in 0..usize_from(count)? {
                let auxiliary_offset = usize::try_from(read_u32(bytes, record + 8, endian)?)
                    .map_err(|_| fail("BUCK2_PRODUCT_ELF", "invalid ELF version offset"))?;
                let auxiliary_count = usize::from(read_u16(bytes, record + 2, endian)?);
                let next_record = usize::try_from(read_u32(bytes, record + 12, endian)?)
                    .map_err(|_| fail("BUCK2_PRODUCT_ELF", "invalid ELF version offset"))?;
                let mut auxiliary = record
                    .checked_add(auxiliary_offset)
                    .ok_or_else(|| fail("BUCK2_PRODUCT_ELF", "ELF version offset overflow"))?;
                for auxiliary_index in 0..auxiliary_count {
                    let name_offset = usize::try_from(read_u32(bytes, auxiliary + 8, endian)?)
                        .map_err(|_| fail("BUCK2_PRODUCT_ELF", "invalid ELF version name"))?;
                    versions.insert(c_string(strings, name_offset, "ELF symbol version")?);
                    let next = usize::try_from(read_u32(bytes, auxiliary + 12, endian)?)
                        .map_err(|_| fail("BUCK2_PRODUCT_ELF", "invalid ELF version offset"))?;
                    if auxiliary_index + 1 < auxiliary_count && next == 0 {
                        return Err(fail(
                            "BUCK2_PRODUCT_ELF",
                            "truncated ELF version auxiliaries",
                        ));
                    }
                    auxiliary = auxiliary
                        .checked_add(next)
                        .ok_or_else(|| fail("BUCK2_PRODUCT_ELF", "ELF version offset overflow"))?;
                }
                if index + 1 < usize_from(count)? && next_record == 0 {
                    return Err(fail("BUCK2_PRODUCT_ELF", "truncated ELF version needs"));
                }
                record = record
                    .checked_add(next_record)
                    .ok_or_else(|| fail("BUCK2_PRODUCT_ELF", "ELF version offset overflow"))?;
            }
        }
        (None, None) => {}
        _ => {
            return Err(fail(
                "BUCK2_PRODUCT_ELF",
                "incomplete ELF version-needs metadata",
            ))
        }
    }
    Ok(json!({
        "elfClass": "ELF64",
        "inspectionContract": "elf-dynamic/v1",
        "interpreter": interpreter,
        "kind": "elf-dynamic",
        "machine": machine,
        "neededLibraries": needed,
        "rpathPolicy": "empty/v1",
        "symbolVersionFloors": versions,
    }))
}

fn elf_static_runtime(bytes: &[u8], architecture: &str) -> ToolResult<Value> {
    let (_, machine, headers) = elf_identity(bytes, architecture, "elf-static/v1")?;
    if !headers.iter().any(|header| header.kind == 1) {
        return Err(fail(
            "BUCK2_PRODUCT_ELF",
            "elf-static/v1 requires a loadable ELF segment",
        ));
    }
    if headers.iter().any(|header| header.kind == 3) {
        return Err(fail("BUCK2_PRODUCT_ELF", "elf-static/v1 forbids PT_INTERP"));
    }
    if headers.iter().any(|header| header.kind == 2) {
        return Err(fail(
            "BUCK2_PRODUCT_ELF",
            "elf-static/v1 forbids PT_DYNAMIC",
        ));
    }
    Ok(json!({
        "elfClass": "ELF64",
        "inspectionContract": "elf-static/v1",
        "kind": "elf-static",
        "machine": machine,
    }))
}

fn be_u32(bytes: &[u8], offset: usize) -> ToolResult<u32> {
    read_u32(bytes, offset, Endian::Big)
}

fn mach_o_signing_policy(bytes: &[u8], offset: usize, size: usize) -> ToolResult<&'static str> {
    let signature_end = offset
        .checked_add(size)
        .ok_or_else(|| fail("BUCK2_PRODUCT_MACHO", "invalid Mach-O code signature range"))?;
    let signature = bytes
        .get(offset..signature_end)
        .ok_or_else(|| fail("BUCK2_PRODUCT_MACHO", "truncated Mach-O code signature"))?;
    if be_u32(signature, 0)? != 0xfade_0cc0 {
        return Err(fail(
            "BUCK2_PRODUCT_MACHO",
            "Mach-O code signature is not a superblob",
        ));
    }
    let declared_size = usize::try_from(be_u32(signature, 4)?)
        .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid code signature size"))?;
    let count = usize::try_from(be_u32(signature, 8)?)
        .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid code signature count"))?;
    if declared_size > signature.len()
        || 12usize.saturating_add(count.saturating_mul(8)) > declared_size
    {
        return Err(fail(
            "BUCK2_PRODUCT_MACHO",
            "malformed code signature superblob",
        ));
    }
    let mut code_directory_found = false;
    let mut ad_hoc_code_directory = false;
    let mut cms_size = None;
    for index in 0..count {
        let entry = 12 + index * 8;
        let slot = be_u32(signature, entry)?;
        let blob_offset = usize::try_from(be_u32(signature, entry + 4)?)
            .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid code signature offset"))?;
        if slot == 0x1_0000 {
            if blob_offset > declared_size.saturating_sub(8) {
                return Err(fail("BUCK2_PRODUCT_MACHO", "invalid CMS signature offset"));
            }
            if cms_size.is_some() {
                return Err(fail("BUCK2_PRODUCT_MACHO", "duplicate CMS signature blob"));
            }
            let magic = be_u32(signature, blob_offset)?;
            let blob_size = usize::try_from(be_u32(signature, blob_offset + 4)?)
                .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid CMS signature size"))?;
            if magic != 0xfade_0b01
                || blob_size < 8
                || blob_offset.saturating_add(blob_size) > declared_size
            {
                return Err(fail("BUCK2_PRODUCT_MACHO", "invalid CMS signature blob"));
            }
            cms_size = Some(blob_size);
        }
        if slot == 0 || (0x1000..=0x1005).contains(&slot) {
            if blob_offset > declared_size.saturating_sub(16) {
                return Err(fail("BUCK2_PRODUCT_MACHO", "invalid CodeDirectory offset"));
            }
            let magic = be_u32(signature, blob_offset)?;
            let blob_size = usize::try_from(be_u32(signature, blob_offset + 4)?)
                .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid CodeDirectory size"))?;
            if !(0xfade_0c02..=0xfade_0c04).contains(&magic)
                || blob_size < 16
                || blob_offset.saturating_add(blob_size) > declared_size
            {
                return Err(fail("BUCK2_PRODUCT_MACHO", "invalid CodeDirectory blob"));
            }
            code_directory_found = true;
            ad_hoc_code_directory |= be_u32(signature, blob_offset + 12)? & 0x2 != 0;
        }
    }
    if !code_directory_found {
        return Err(fail(
            "BUCK2_PRODUCT_MACHO",
            "Mach-O CodeDirectory is missing",
        ));
    }
    match (ad_hoc_code_directory, cms_size) {
        (true, Some(8)) => Ok("adhoc/v1"),
        (false, Some(size)) if size > 8 => Ok("embedded/v1"),
        (true, Some(_)) => Err(fail(
            "BUCK2_PRODUCT_MACHO",
            "ad-hoc Mach-O CodeDirectory has a non-empty CMS signature",
        )),
        (false, _) => Err(fail(
            "BUCK2_PRODUCT_MACHO",
            "non-ad-hoc Mach-O CodeDirectory has no embedded CMS signature",
        )),
        (true, None) => Err(fail(
            "BUCK2_PRODUCT_MACHO",
            "ad-hoc Mach-O CodeDirectory has no empty CMS wrapper",
        )),
    }
}

fn packed_version(value: u32) -> String {
    let major = value >> 16;
    let minor = (value >> 8) & 0xff;
    let patch = value & 0xff;
    if patch == 0 {
        format!("{major}.{minor}")
    } else {
        format!("{major}.{minor}.{patch}")
    }
}

fn mach_o_runtime(bytes: &[u8], architecture: &str) -> ToolResult<Value> {
    if bytes.get(..4) != Some(&[0xcf, 0xfa, 0xed, 0xfe]) {
        return Err(fail(
            "BUCK2_PRODUCT_MACHO",
            "mach-o-dynamic/v1 requires a thin little-endian Mach-O 64 executable",
        ));
    }
    let observed_architecture = match read_u32(bytes, 4, Endian::Little)? {
        0x0100_0007 => "x86_64",
        0x0100_000c => "arm64",
        value => {
            return Err(fail(
                "BUCK2_PRODUCT_MACHO",
                format!("unsupported Mach-O CPU type: {value:#x}"),
            ))
        }
    };
    let expected_architecture = match architecture {
        "x86_64" => "x86_64",
        "aarch64" => "arm64",
        value => {
            return Err(fail(
                "BUCK2_PRODUCT_PLATFORM",
                format!("unsupported Darwin architecture: {value}"),
            ))
        }
    };
    if observed_architecture != expected_architecture {
        return Err(fail(
            "BUCK2_PRODUCT_PLATFORM",
            "Mach-O architecture does not match platform architecture",
        ));
    }
    let command_count = usize::try_from(read_u32(bytes, 16, Endian::Little)?)
        .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid load-command count"))?;
    let command_bytes = usize::try_from(read_u32(bytes, 20, Endian::Little)?)
        .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid load-command size"))?;
    bytes
        .get(32..32 + command_bytes)
        .ok_or_else(|| fail("BUCK2_PRODUCT_MACHO", "truncated Mach-O load commands"))?;
    let mut offset = 32usize;
    let mut dylibs = BTreeSet::new();
    let mut minimum_os = None;
    let mut signature = None;
    for _ in 0..command_count {
        let command = read_u32(bytes, offset, Endian::Little)?;
        let size = usize::try_from(read_u32(bytes, offset + 4, Endian::Little)?)
            .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid load-command size"))?;
        if size < 8 || offset + size > 32 + command_bytes {
            return Err(fail("BUCK2_PRODUCT_MACHO", "malformed Mach-O load command"));
        }
        match command {
            0x0c | 0x20 | 0x8000_0018 | 0x8000_001f | 0x8000_0023 => {
                let name_offset = usize::try_from(read_u32(bytes, offset + 8, Endian::Little)?)
                    .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid dylib name offset"))?;
                if name_offset >= size {
                    return Err(fail("BUCK2_PRODUCT_MACHO", "invalid dylib name offset"));
                }
                let name = c_string(&bytes[offset..offset + size], name_offset, "Mach-O dylib")?;
                if !(name.starts_with("/usr/lib/") || name.starts_with("/System/Library/")) {
                    return Err(fail(
                        "BUCK2_PRODUCT_MACHO",
                        format!("Mach-O dylib is outside the system install-name policy: {name}"),
                    ));
                }
                dylibs.insert(name);
            }
            0x8000_001c => {
                return Err(fail(
                    "BUCK2_PRODUCT_MACHO",
                    "mach-o-dynamic/v1 forbids LC_RPATH",
                ))
            }
            0x1d => {
                if signature.is_some() {
                    return Err(fail("BUCK2_PRODUCT_MACHO", "duplicate LC_CODE_SIGNATURE"));
                }
                signature = Some((
                    usize::try_from(read_u32(bytes, offset + 8, Endian::Little)?)
                        .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid signature offset"))?,
                    usize::try_from(read_u32(bytes, offset + 12, Endian::Little)?)
                        .map_err(|_| fail("BUCK2_PRODUCT_MACHO", "invalid signature size"))?,
                ));
            }
            0x32 => {
                if minimum_os.is_some() || read_u32(bytes, offset + 8, Endian::Little)? != 1 {
                    return Err(fail(
                        "BUCK2_PRODUCT_MACHO",
                        "Mach-O must contain exactly one macOS LC_BUILD_VERSION",
                    ));
                }
                minimum_os = Some(packed_version(read_u32(
                    bytes,
                    offset + 12,
                    Endian::Little,
                )?));
            }
            _ => {}
        }
        offset += size;
    }
    if offset != 32 + command_bytes {
        return Err(fail("BUCK2_PRODUCT_MACHO", "load-command size mismatch"));
    }
    let (signature_offset, signature_size) = signature
        .filter(|(_, size)| *size > 0)
        .ok_or_else(|| fail("BUCK2_PRODUCT_MACHO", "Mach-O has no code signature"))?;
    let signing_policy = mach_o_signing_policy(bytes, signature_offset, signature_size)?;
    Ok(json!({
        "architecture": observed_architecture,
        "dylibs": dylibs,
        "inspectionContract": "mach-o-dynamic/v1",
        "installNamePolicy": "system-only/v1",
        "kind": "mach-o-dynamic",
        "minimumOs": minimum_os.ok_or_else(|| fail("BUCK2_PRODUCT_MACHO", "Mach-O has no LC_BUILD_VERSION"))?,
        "rpathPolicy": "empty/v1",
        "signingPolicy": signing_policy,
    }))
}

fn tar_header(path: &str, size: u64, kind: EntryType, mode: u32) -> ToolResult<Header> {
    let mut header = Header::new_ustar();
    header.set_entry_type(kind);
    header.set_size(size);
    header.set_mode(mode);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header
        .set_username("")
        .map_err(|error| fail("BUCK2_PRODUCT_TAR", error.to_string()))?;
    header
        .set_groupname("")
        .map_err(|error| fail("BUCK2_PRODUCT_TAR", error.to_string()))?;
    header
        .set_path(path)
        .map_err(|error| fail("BUCK2_PRODUCT_TAR", error.to_string()))?;
    header.set_cksum();
    Ok(header)
}

fn collect_support_files(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> ToolResult<()> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| {
            fail(
                "BUCK2_PRODUCT_INPUT",
                format!("could not read support tree: {error}"),
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            fail(
                "BUCK2_PRODUCT_INPUT",
                format!("could not read support tree: {error}"),
            )
        })?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            fail(
                "BUCK2_PRODUCT_INPUT",
                format!("could not inspect support-tree entry: {error}"),
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(fail(
                "BUCK2_PRODUCT_INPUT",
                "support tree must not contain symlinks",
            ));
        }
        if metadata.is_dir() {
            collect_support_files(root, &path, files)?;
        } else if metadata.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|error| fail("BUCK2_PRODUCT_INPUT", error.to_string()))?
                .to_str()
                .ok_or_else(|| fail("BUCK2_PRODUCT_INPUT", "support-tree path is not UTF-8"))?;
            let relative = normalized_relative(relative, "support-tree path")?.to_owned();
            let bytes = fs::read(&path).map_err(|error| {
                fail(
                    "BUCK2_PRODUCT_INPUT",
                    format!("could not read support-tree file: {error}"),
                )
            })?;
            files.insert(relative, bytes);
        } else {
            return Err(fail(
                "BUCK2_PRODUCT_INPUT",
                "support tree must contain only regular files and directories",
            ));
        }
    }
    Ok(())
}

fn archive(
    executable: &[u8],
    entrypoint: &str,
    support_tree: Option<&Path>,
) -> ToolResult<Vec<u8>> {
    let mut files = BTreeMap::new();
    if let Some(root) = support_tree {
        let metadata = fs::symlink_metadata(root).map_err(|error| {
            fail(
                "BUCK2_PRODUCT_INPUT",
                format!("support tree is unavailable: {error}"),
            )
        })?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(fail(
                "BUCK2_PRODUCT_INPUT",
                "support tree must be a regular non-symlink directory",
            ));
        }
        collect_support_files(root, root, &mut files)?;
    }
    if files
        .insert(entrypoint.to_owned(), executable.to_vec())
        .is_some()
    {
        return Err(fail(
            "BUCK2_PRODUCT_INPUT",
            "support tree collides with the executable entrypoint",
        ));
    }

    let mut directories = BTreeSet::new();
    for path in files.keys() {
        let components = path.split('/').collect::<Vec<_>>();
        for end in 1..components.len() {
            directories.insert(components[..end].join("/"));
        }
    }

    let mut bytes = Vec::new();
    {
        let mut builder = Builder::new(&mut bytes);
        for directory in directories {
            let header = tar_header(&directory, 0, EntryType::Directory, 0o555)?;
            builder
                .append(&header, std::io::empty())
                .map_err(|error| fail("BUCK2_PRODUCT_TAR", error.to_string()))?;
        }
        for (path, contents) in files {
            let mode = if path == entrypoint { 0o555 } else { 0o444 };
            let header = tar_header(
                &path,
                u64::try_from(contents.len())
                    .map_err(|_| fail("BUCK2_PRODUCT_TAR", "product file is too large"))?,
                EntryType::Regular,
                mode,
            )?;
            builder
                .append(&header, contents.as_slice())
                .map_err(|error| fail("BUCK2_PRODUCT_TAR", error.to_string()))?;
        }
        builder
            .finish()
            .map_err(|error| fail("BUCK2_PRODUCT_TAR", error.to_string()))?;
    }
    Ok(bytes)
}

fn validate_name(value: &str) -> ToolResult<&str> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
    {
        return Err(fail(
            "BUCK2_PRODUCT_NAME",
            "name is not accepted by the Nix contract",
        ));
    }
    Ok(value)
}

fn package(args: PackageArgs) -> ToolResult<()> {
    validate_name(&args.name)?;
    safe_text(&args.target, "target")?;
    safe_text(&args.platform_os, "platform OS")?;
    safe_text(&args.platform_architecture, "platform architecture")?;
    safe_text(&args.platform_abi, "platform ABI")?;
    let entrypoint = normalized_relative(&args.entrypoint, "entrypoint")?;
    let metadata = fs::symlink_metadata(&args.executable).map_err(|error| {
        fail(
            "BUCK2_PRODUCT_INPUT",
            format!("executable is unavailable: {error}"),
        )
    })?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o111 == 0
    {
        return Err(fail(
            "BUCK2_PRODUCT_INPUT",
            "executable must be an executable regular non-symlink file",
        ));
    }
    let executable = fs::read(&args.executable).map_err(|error| {
        fail(
            "BUCK2_PRODUCT_INPUT",
            format!("could not read executable: {error}"),
        )
    })?;
    if executable.is_empty() {
        return Err(fail("BUCK2_PRODUCT_INPUT", "executable must not be empty"));
    }
    let runtime = match args.runtime_contract.as_str() {
        "elf-dynamic/v1" => {
            if args.platform_os != "linux" || args.platform_abi != "glibc" {
                return Err(fail(
                    "BUCK2_PRODUCT_PLATFORM",
                    "elf-dynamic/v1 requires linux/glibc",
                ));
            }
            elf_runtime(&executable, &args.platform_architecture)?
        }
        "elf-static/v1" => {
            if args.platform_os != "linux" || args.platform_abi != "glibc" {
                return Err(fail(
                    "BUCK2_PRODUCT_PLATFORM",
                    "elf-static/v1 requires linux/glibc",
                ));
            }
            elf_static_runtime(&executable, &args.platform_architecture)?
        }
        "mach-o-dynamic/v1" => {
            if args.platform_os != "darwin" || args.platform_abi != "darwin" {
                return Err(fail(
                    "BUCK2_PRODUCT_PLATFORM",
                    "mach-o-dynamic/v1 requires darwin/darwin",
                ));
            }
            mach_o_runtime(&executable, &args.platform_architecture)?
        }
        value => {
            return Err(fail(
                "BUCK2_PRODUCT_RUNTIME",
                format!("unsupported runtime contract: {value}"),
            ))
        }
    };
    let provenance_bytes = fs::read(&args.provenance).map_err(|error| {
        fail(
            "BUCK2_PRODUCT_PROVENANCE",
            format!("could not read provenance: {error}"),
        )
    })?;
    let provenance: Provenance = serde_json::from_slice(&provenance_bytes).map_err(|error| {
        fail(
            "BUCK2_PRODUCT_PROVENANCE",
            format!("invalid provenance: {error}"),
        )
    })?;
    if provenance.schema != "buck-build-provenance/v1" {
        return Err(fail(
            "BUCK2_PRODUCT_PROVENANCE",
            "unsupported provenance schema",
        ));
    }
    safe_text(&provenance.recipe, "provenance recipe")?;
    safe_text(&provenance.toolchain, "provenance toolchain")?;

    let artifact = archive(&executable, &entrypoint, args.support_tree.as_deref())?;
    let digest = sha256_sri(&sha256_bytes(&artifact))?;
    let descriptor = json!({
        "entrypoints": [entrypoint],
        "name": args.name,
        "payload": {
            "digest": {"algorithm": "sha256", "sri": digest},
            "file": "artifact.tar",
            "format": "tar",
            "sizeBytes": artifact.len(),
        },
        "platform": {
            "abi": args.platform_abi,
            "architecture": args.platform_architecture,
            "os": args.platform_os,
        },
        "runtime": runtime,
        "schema": "buck-build-product/v1",
        "semanticProvenance": {
            "recipe": provenance.recipe,
            "target": args.target,
            "toolchain": provenance.toolchain,
        },
    });
    fs::write(&args.artifact, artifact).map_err(|error| {
        fail(
            "BUCK2_PRODUCT_OUTPUT",
            format!("could not write artifact: {error}"),
        )
    })?;
    fs::write(&args.descriptor, canonical_json(&descriptor)?).map_err(|error| {
        fail(
            "BUCK2_PRODUCT_OUTPUT",
            format!("could not write descriptor: {error}"),
        )
    })
}

fn main() {
    let cli = Cli::parse();
    let result = verify_execution_capability(
        &cli.capability_manifest,
        "product",
        "effect-utils/buck2-product/v1",
        "native-executable/v1",
    )
    .and_then(|()| match cli.command {
        Command::Package(args) => package(args),
    });
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    use std::io::Read;
    use std::path::Path;
    use tempfile::tempdir;

    #[cfg(target_os = "linux")]
    fn clean_elf_fixture(root: &Path) -> PathBuf {
        let mut bytes = fs::read(std::env::current_exe().unwrap()).unwrap();
        let endian = match bytes[5] {
            1 => Endian::Little,
            2 => Endian::Big,
            _ => panic!("test executable is not ELF"),
        };
        let program_offset = usize_from(read_u64(&bytes, 32, endian).unwrap()).unwrap();
        let entry_size = usize::from(read_u16(&bytes, 54, endian).unwrap());
        let entry_count = usize::from(read_u16(&bytes, 56, endian).unwrap());
        for index in 0..entry_count {
            let header = program_offset + index * entry_size;
            if read_u32(&bytes, header, endian).unwrap() != 2 {
                continue;
            }
            let offset = usize_from(read_u64(&bytes, header + 8, endian).unwrap()).unwrap();
            let size = usize_from(read_u64(&bytes, header + 32, endian).unwrap()).unwrap();
            for entry in bytes[offset..offset + size].chunks_exact_mut(16) {
                if matches!(read_u64(entry, 0, endian).unwrap(), 15 | 29) {
                    let replacement = match endian {
                        Endian::Little => 21u64.to_le_bytes(),
                        Endian::Big => 21u64.to_be_bytes(),
                    };
                    entry[..8].copy_from_slice(&replacement);
                }
            }
        }
        let fixture = root.join("fixture-elf");
        fs::write(&fixture, bytes).unwrap();
        fs::set_permissions(&fixture, fs::Permissions::from_mode(0o555)).unwrap();
        fixture
    }

    #[cfg(target_os = "linux")]
    fn static_elf_fixture(root: &Path) -> PathBuf {
        let mut bytes = fs::read(std::env::current_exe().unwrap()).unwrap();
        let endian = match bytes[5] {
            1 => Endian::Little,
            2 => Endian::Big,
            _ => panic!("test executable is not ELF"),
        };
        let program_offset = usize_from(read_u64(&bytes, 32, endian).unwrap()).unwrap();
        let entry_size = usize::from(read_u16(&bytes, 54, endian).unwrap());
        let entry_count = usize::from(read_u16(&bytes, 56, endian).unwrap());
        for index in 0..entry_count {
            let header = program_offset + index * entry_size;
            if !matches!(read_u32(&bytes, header, endian).unwrap(), 2 | 3) {
                continue;
            }
            let replacement = match endian {
                Endian::Little => 4u32.to_le_bytes(),
                Endian::Big => 4u32.to_be_bytes(),
            };
            bytes[header..header + 4].copy_from_slice(&replacement);
        }
        let fixture = root.join("fixture-static-elf");
        fs::write(&fixture, bytes).unwrap();
        fs::set_permissions(&fixture, fs::Permissions::from_mode(0o555)).unwrap();
        fixture
    }

    fn args(root: &Path, executable: PathBuf) -> PackageArgs {
        let provenance = root.join("provenance.json");
        fs::write(&provenance, br#"{"schema":"buck-build-provenance/v1","recipe":"effect-utils/v1","toolchain":"rust-test"}"#).unwrap();
        PackageArgs {
            executable,
            support_tree: None,
            entrypoint: "bin/tool".into(),
            artifact: root.join("artifact.tar"),
            name: "tool".into(),
            target: "//pkg:product".into(),
            platform_os: "linux".into(),
            platform_architecture: std::env::consts::ARCH.into(),
            platform_abi: "glibc".into(),
            runtime_contract: "elf-dynamic/v1".into(),
            provenance,
            descriptor: root.join("descriptor.json"),
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn packages_a_canonical_descriptor_from_the_inspected_executable() {
        let temporary = tempdir().unwrap();
        let executable = clean_elf_fixture(temporary.path());
        let arguments = args(temporary.path(), executable.clone());
        package(arguments).unwrap();
        let descriptor: Value =
            serde_json::from_slice(&fs::read(temporary.path().join("descriptor.json")).unwrap())
                .unwrap();
        let artifact = fs::read(temporary.path().join("artifact.tar")).unwrap();
        assert_eq!(descriptor["schema"], "buck-build-product/v1");
        assert_eq!(descriptor["semanticProvenance"]["target"], "//pkg:product");
        assert_eq!(descriptor["runtime"]["kind"], "elf-dynamic");
        assert_eq!(descriptor["runtime"]["machine"], std::env::consts::ARCH);
        assert_eq!(descriptor["payload"]["sizeBytes"], artifact.len());
        assert_eq!(
            descriptor["payload"]["digest"]["sri"],
            sha256_sri(&sha256_bytes(&artifact)).unwrap()
        );
        let mut archive = tar::Archive::new(artifact.as_slice());
        let mut entries = archive.entries().unwrap();
        assert_eq!(
            entries.next().unwrap().unwrap().path().unwrap(),
            Path::new("bin")
        );
        let mut entry = entries.next().unwrap().unwrap();
        assert_eq!(entry.path().unwrap(), Path::new("bin/tool"));
        let mut contents = Vec::new();
        entry.read_to_end(&mut contents).unwrap();
        assert_eq!(contents, fs::read(executable).unwrap());
        assert!(entries.next().is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn packages_a_static_elf_under_the_static_runtime_contract() {
        let temporary = tempdir().unwrap();
        let mut arguments = args(temporary.path(), static_elf_fixture(temporary.path()));
        arguments.runtime_contract = "elf-static/v1".into();
        package(arguments).unwrap();
        let descriptor: Value =
            serde_json::from_slice(&fs::read(temporary.path().join("descriptor.json")).unwrap())
                .unwrap();
        assert_eq!(descriptor["runtime"]["kind"], "elf-static");
        assert_eq!(descriptor["runtime"]["inspectionContract"], "elf-static/v1");
        assert_eq!(descriptor["runtime"]["machine"], std::env::consts::ARCH);
    }

    fn signature_with_cms(code_directory_flags: u32, cms_size: u32) -> Vec<u8> {
        let declared_size = 44 + cms_size;
        let mut signature = Vec::new();
        for value in [
            0xfade_0cc0u32,
            declared_size,
            2,
            0,
            28,
            0x1_0000,
            44,
            0xfade_0c02,
            16,
            0,
            code_directory_flags,
            0xfade_0b01,
            cms_size,
        ] {
            signature.extend_from_slice(&value.to_be_bytes());
        }
        signature.resize(usize::try_from(declared_size).unwrap(), 0);
        signature
    }

    #[test]
    fn distinguishes_ad_hoc_and_embedded_mach_o_signatures() {
        let ad_hoc = signature_with_cms(0x2, 8);
        assert_eq!(
            mach_o_signing_policy(&ad_hoc, 0, ad_hoc.len()).unwrap(),
            "adhoc/v1"
        );

        let embedded = signature_with_cms(0, 16);
        assert_eq!(
            mach_o_signing_policy(&embedded, 0, embedded.len()).unwrap(),
            "embedded/v1"
        );
    }

    #[test]
    fn archive_bytes_are_deterministic_and_normalized() {
        let first = archive(b"executable", "libexec/example/tool", None).unwrap();
        let second = archive(b"executable", "libexec/example/tool", None).unwrap();
        assert_eq!(first, second);
        let mut archive = tar::Archive::new(first.as_slice());
        let entries = archive
            .entries()
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (
                    entry.path().unwrap().into_owned(),
                    entry.header().mode().unwrap(),
                    entry.header().mtime().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            entries,
            vec![
                (PathBuf::from("libexec"), 0o555, 0),
                (PathBuf::from("libexec/example"), 0o555, 0),
                (PathBuf::from("libexec/example/tool"), 0o555, 0),
            ]
        );
    }

    #[test]
    fn archives_support_tree_files_next_to_the_entrypoint() {
        let temporary = tempdir().unwrap();
        let support_tree = temporary.path().join("support");
        fs::create_dir_all(support_tree.join("bin")).unwrap();
        fs::write(support_tree.join("bin/lib.d.ts"), b"interface Array {}").unwrap();
        fs::write(support_tree.join("bin/tsc.sig"), b"signature").unwrap();
        let bytes = archive(
            b"executable",
            "bin/typescript-api-server",
            Some(&support_tree),
        )
        .unwrap();
        let mut archive = tar::Archive::new(bytes.as_slice());
        let entries = archive
            .entries()
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (
                    entry.path().unwrap().into_owned(),
                    entry.header().mode().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            entries,
            vec![
                (PathBuf::from("bin"), 0o555),
                (PathBuf::from("bin/lib.d.ts"), 0o444),
                (PathBuf::from("bin/tsc.sig"), 0o444),
                (PathBuf::from("bin/typescript-api-server"), 0o555),
            ]
        );
    }

    #[test]
    fn rejects_unsafe_entrypoints_before_writing_outputs() {
        let temporary = tempdir().unwrap();
        let mut arguments = args(temporary.path(), std::env::current_exe().unwrap());
        arguments.entrypoint = "bin/../tool".into();
        assert_eq!(package(arguments).unwrap_err().code, "BUCK2_INVALID_PATH");
        assert!(!temporary.path().join("artifact.tar").exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn runtime_contract_must_match_the_native_executable() {
        let temporary = tempdir().unwrap();
        let mut arguments = args(temporary.path(), clean_elf_fixture(temporary.path()));
        arguments.platform_architecture = match std::env::consts::ARCH {
            "x86_64" => "aarch64",
            "aarch64" => "x86_64",
            _ => "unsupported-test-architecture",
        }
        .into();
        assert_eq!(
            package(arguments).unwrap_err().code,
            "BUCK2_PRODUCT_PLATFORM"
        );
        assert!(!temporary.path().join("descriptor.json").exists());
    }
}
