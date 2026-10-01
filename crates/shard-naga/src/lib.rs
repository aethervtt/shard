//! naga for Shard's WebGL2 backend (0064): one WGSL entry point in, GLSL ES 3.00 out, with the
//! binding reflection the shim binds by.
//!
//! A C ABI over linear memory, no wasm-bindgen: the host copies the source and entry point into
//! memory from `alloc`, calls `translate`, then reads the JSON at `result_ptr` / `result_len`:
//!
//! ```json
//! { "glsl": "...", "textures": [{ "name": "...", "group": 0, "binding": 2, "sampler": [0, 3] }],
//!   "uniforms": [{ "name": "...", "group": 0, "binding": 0 }],
//!   "varyings": [{ "name": "...", "location": 0 }], "firstInstance": false }
//! ```
//!
//! or `{ "error": "..." }` with naga's message and source location. A panic aborts the instance
//! (the release profile has `panic = "abort"`); the host makes a new one.

use naga::back::glsl;
use naga::valid::{Capabilities, ValidationFlags, Validator};
use std::fmt::Write as _;
use std::sync::Mutex;

static RESULT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

/// `gl_Position.y` flipped and z mapped from [0, 1] to [-1, 1] (naga's ADJUST_COORDINATE_SPACE).
pub const FLAG_ADJUST_COORDINATE_SPACE: u32 = 1;

/// The naga release this module was built with: part of every translation's cache key.
pub const NAGA_VERSION: &str = "30.0.1";

/// Memory for the host to write `len` bytes into; give it back with `dealloc`.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// Frees memory from `alloc`.
///
/// # Safety
/// `ptr` and `len` must be exactly what `alloc` returned and was called with.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
}

/// Translates entry point `entry` of stage `stage` (0 vertex, 1 fragment). Returns 0 with the
/// result JSON, or 1 with an error JSON.
///
/// # Safety
/// `source` and `entry` must point at `source_len` and `entry_len` bytes of UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn translate(
    source: *const u8,
    source_len: usize,
    entry: *const u8,
    entry_len: usize,
    stage: u32,
    flags: u32,
) -> u32 {
    let text = |ptr: *const u8, len: usize| {
        String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(ptr, len) }).into_owned()
    };
    let source = text(source, source_len);
    let entry = text(entry, entry_len);
    let (status, json) = match translate_str(&source, &entry, stage, flags) {
        Ok(json) => (0, json),
        Err(message) => (1, format!("{{\"error\":{}}}", quote(&message))),
    };
    set_result(json);
    status
}

/// Puts naga's version in the result buffer.
#[unsafe(no_mangle)]
pub extern "C" fn version() -> u32 {
    set_result(NAGA_VERSION.to_string());
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn result_ptr() -> *const u8 {
    RESULT.lock().map(|r| r.as_ptr()).unwrap_or(std::ptr::null())
}

#[unsafe(no_mangle)]
pub extern "C" fn result_len() -> usize {
    RESULT.lock().map(|r| r.len()).unwrap_or(0)
}

fn set_result(json: String) {
    if let Ok(mut result) = RESULT.lock() {
        *result = json.into_bytes();
    }
}

/// The translation as JSON, or naga's error with its source location.
pub fn translate_str(source: &str, entry: &str, stage: u32, flags: u32) -> Result<String, String> {
    let shader_stage = match stage {
        0 => naga::ShaderStage::Vertex,
        1 => naga::ShaderStage::Fragment,
        _ => return Err(format!("Stage {stage} isn't a render stage")),
    };
    let module = naga::front::wgsl::parse_str(source).map_err(|e| e.emit_to_string(source))?;
    // Everything validates; the GLSL writer then refuses what ES 3.00 can't do, by name.
    let info = Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(&module)
        .map_err(|e| e.emit_to_string(source))?;
    let mut writer_flags = glsl::WriterFlags::empty();
    if flags & FLAG_ADJUST_COORDINATE_SPACE != 0 {
        writer_flags |= glsl::WriterFlags::ADJUST_COORDINATE_SPACE;
    }
    let options = glsl::Options {
        version: glsl::Version::Embedded { version: 300, is_webgl: true },
        writer_flags,
        binding_map: glsl::BindingMap::default(),
        zero_initialize_workgroup_memory: false,
    };
    let pipeline = glsl::PipelineOptions {
        shader_stage,
        entry_point: entry.to_string(),
        multiview: None,
    };
    let mut glsl_out = String::new();
    let reflection = glsl::Writer::new(
        &mut glsl_out,
        &module,
        &info,
        &options,
        &pipeline,
        naga::proc::BoundsCheckPolicies::default(),
    )
    .and_then(|mut writer| writer.write())
    .map_err(|e| format!("{entry}: {e}"))?;

    let binding = |handle: naga::Handle<naga::GlobalVariable>| {
        module.global_variables[handle].binding.as_ref().map(|b| (b.group, b.binding))
    };
    let mut textures: Vec<_> = reflection
        .texture_mapping
        .iter()
        .filter_map(|(name, mapping)| {
            binding(mapping.texture).map(|b| (name.clone(), b, mapping.sampler.and_then(binding)))
        })
        .collect();
    textures.sort_by(|a, b| a.0.cmp(&b.0));
    let mut uniforms: Vec<_> = reflection
        .uniforms
        .iter()
        .filter_map(|(handle, name)| binding(*handle).map(|b| (name.clone(), b)))
        .collect();
    uniforms.sort_by(|a, b| a.0.cmp(&b.0));
    let mut varyings: Vec<_> =
        reflection.varying.iter().map(|(name, v)| (name.clone(), v.location)).collect();
    varyings.sort_by(|a, b| a.0.cmp(&b.0));

    let mut json = String::with_capacity(glsl_out.len() + 256);
    json.push_str("{\"glsl\":");
    json.push_str(&quote(&glsl_out));
    json.push_str(",\"textures\":[");
    for (i, (name, (group, index), sampler)) in textures.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        let _ = write!(
            json,
            "{{\"name\":{},\"group\":{group},\"binding\":{index},\"sampler\":",
            quote(name)
        );
        match sampler {
            Some((g, b)) => {
                let _ = write!(json, "[{g},{b}]}}");
            }
            None => json.push_str("null}"),
        }
    }
    json.push_str("],\"uniforms\":[");
    for (i, (name, (group, index))) in uniforms.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        let _ = write!(json, "{{\"name\":{},\"group\":{group},\"binding\":{index}}}", quote(name));
    }
    json.push_str("],\"varyings\":[");
    for (i, (name, location)) in varyings.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        let _ = write!(json, "{{\"name\":{},\"location\":{location}}}", quote(name));
    }
    let _ = write!(
        json,
        "],\"firstInstance\":{}}}",
        glsl_out.contains(glsl::FIRST_INSTANCE_BINDING)
    );
    Ok(json)
}

/// A JSON string literal.
fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHADER: &str = r#"
struct View { view_proj: mat4x4f, tint: vec4f }
@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var albedo: texture_2d<f32>;
@group(1) @binding(1) var albedo_sampler: sampler;
@group(1) @binding(2) var data: texture_2d<u32>;

struct Out { @builtin(position) clip: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) id: u32 }

@vertex fn vs(@builtin(instance_index) i: u32, @location(0) position: vec3f) -> Out {
  var out: Out;
  out.clip = view.view_proj * vec4f(position, 1.0);
  out.uv = position.xy;
  out.id = textureLoad(data, vec2i(i32(i), 0), 0).x;
  return out;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  return textureSample(albedo, albedo_sampler, in.uv) * view.tint + f32(in.id);
}
"#;

    #[test]
    fn translates_both_stages_with_reflection() {
        let vs = translate_str(SHADER, "vs", 0, FLAG_ADJUST_COORDINATE_SPACE).unwrap();
        assert!(vs.contains("#version 300 es"));
        assert!(vs.contains("gl_Position.yz"));
        assert!(vs.contains("\"firstInstance\":true"));
        assert!(vs.contains("\"group\":0,\"binding\":0"));
        let fs = translate_str(SHADER, "fs", 1, FLAG_ADJUST_COORDINATE_SPACE).unwrap();
        assert!(fs.contains("\"sampler\":[1,1]"));
        assert!(fs.contains("\"firstInstance\":false"));
    }

    #[test]
    fn errors_name_the_line() {
        let err = translate_str("fn broken( {", "vs", 0, 0).unwrap_err();
        assert!(err.contains(":1:"), "{err}");
        let err = translate_str(SHADER, "nope", 0, 0).unwrap_err();
        assert!(err.contains("nope"), "{err}");
    }
}
