/** UI mode only; API permissions are always checked server-side. */
export function settingsPortalMode(search){return new URLSearchParams(search).get('android_settings')==='1';}
export function settingsPortalView(view){return view==='settings';}
