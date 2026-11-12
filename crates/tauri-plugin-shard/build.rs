// Generates the commands' permissions (allow-<command>), which permissions/default.toml grants.
const COMMANDS: &[&str] = &[
    "base",
    "storage_read",
    "storage_write",
    "storage_list",
    "storage_delete",
    "server_start",
    "server_stop",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
