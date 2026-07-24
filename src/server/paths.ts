// Per-OS app-data-directory resolution, replacing Tauri's
// `app.path().app_data_dir()`.

const APP_ID = "com.magmast.satelita";

export function appDataDir(): string {
  const os = Deno.build.os;
  if (os === "darwin") {
    return `${Deno.env.get("HOME")}/Library/Application Support/${APP_ID}`;
  }
  if (os === "windows") {
    const appData = Deno.env.get("APPDATA") ?? `${Deno.env.get("USERPROFILE")}\\AppData\\Roaming`;
    return `${appData}\\${APP_ID}`;
  }
  const xdg = Deno.env.get("XDG_DATA_HOME") ?? `${Deno.env.get("HOME")}/.local/share`;
  return `${xdg}/${APP_ID}`;
}

export function recordingsDir(runId: string): string {
  return `${appDataDir()}/recordings/${runId}`;
}
