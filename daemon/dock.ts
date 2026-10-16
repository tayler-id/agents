// Each seat's window manager and dock: JWM's configuration and the dock's
// icons, written by the daemon for each seat. Windows have title bars and can
// be moved, resized and switched, from the dock's list of open windows or with
// Alt+Tab. The dock along the bottom opens a browser window, a terminal and the
// whiteboard (daemon/whiteboard.ts), one square button each from the left,
// named on hover. The browser and whiteboard buttons open windows in the seat's
// own browser over its DevTools port, so a click never starts a second browser
// on the seat's profile. Colors are neutral greys.

import { fileURLToPath } from 'node:url'

// The dock's height in pixels. Its buttons are squares that tall, from the
// left edge of the screen.
export const DOCK_HEIGHT = 32
// The dock's buttons, left to right.
export const DOCK_BUTTONS = ['Browser', 'Terminal', 'Whiteboard'] as const
export type DockButton = (typeof DOCK_BUTTONS)[number]

// Each button's icon, drawn in light grey on the dock's dark grey.
const ICON_STROKE = '#e8e8e8'
const ICONS: Record<DockButton, string> = {
  Browser: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  Terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  Whiteboard: '<rect x="3" y="4" width="18" height="14" rx="1"/><path d="M6 14c2-5 4 2 6-2s3 1 5-3M9 21l3-3 3 3"/>',
}
export const dockIcon = (button: DockButton) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${ICON_STROKE}" `
  + `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[button]}</svg>\n`

const OPEN_WINDOW = fileURLToPath(new URL('./open-window.ts', import.meta.url))
const FONT = 'Liberation Sans-10'
// The terminal's background, which checks look for on the screen.
export const TERMINAL_BACKGROUND = '#1e1e1e'
// UTF-8, so text outside ASCII shows as typed.
const TERMINAL = `env LANG=C.UTF-8 xterm -fa 'Liberation Mono' -fs 11 -bg '${TERMINAL_BACKGROUND}' -fg '#e6e6e6' -geometry 100x30`

export type DockConfig = {
  // The seat browser's DevTools address, which the dock's buttons open windows through.
  cdpUrl: string
  whiteboardUrl: string
  // Where each button's icon is, written beside the configuration.
  iconOf: (button: DockButton) => string
}

// The command line a dock button runs, read by /bin/sh.
const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
const openWindow = (cdpUrl: string, url: string) => `${quoted(process.execPath)} ${quoted(OPEN_WINDOW)} ${quoted(cdpUrl)} ${quoted(url)}`

export function commandOf(button: DockButton, config: DockConfig): string {
  switch (button) {
    case 'Browser': return openWindow(config.cdpUrl, 'about:blank')
    case 'Terminal': return TERMINAL
    case 'Whiteboard': return openWindow(config.cdpUrl, config.whiteboardUrl)
  }
}

const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

// JWM's configuration for one seat.
export function dockConfig(config: DockConfig): string {
  const buttons = DOCK_BUTTONS.map((button) =>
    `    <TrayButton icon="${xml(config.iconOf(button))}" popup="${button}">exec:${xml(commandOf(button, config))}</TrayButton>`).join('\n')
  const launchers = DOCK_BUTTONS.map((button) => `    <Program label="${button}">${xml(commandOf(button, config))}</Program>`).join('\n')
  return `<?xml version="1.0"?>
<JWM>
  <Tray x="0" y="-1" height="${DOCK_HEIGHT}" autohide="off" layer="above">
${buttons}
    <TaskList maxwidth="240"/>
  </Tray>
  <RootMenu onroot="3">
${launchers}
  </RootMenu>
  <WindowStyle>
    <Font>${FONT}</Font>
    <Height>24</Height>
    <Width>3</Width>
    <Corner>0</Corner>
    <Foreground>#d8d8d8</Foreground>
    <Background>#4a4a4a</Background>
    <Outline>#3a3a3a</Outline>
    <Active>
      <Foreground>#ffffff</Foreground>
      <Background>#2e2e2e</Background>
      <Outline>#262626</Outline>
    </Active>
  </WindowStyle>
  <TrayStyle>
    <Font>${FONT}</Font>
    <Background>#262626</Background>
    <Foreground>#e8e8e8</Foreground>
  </TrayStyle>
  <TrayButtonStyle>
    <Font>${FONT}</Font>
    <Background>#262626</Background>
    <Foreground>#e8e8e8</Foreground>
  </TrayButtonStyle>
  <TaskListStyle>
    <Font>${FONT}</Font>
    <Background>#262626</Background>
    <Foreground>#bdbdbd</Foreground>
    <Active>
      <Background>#3c3c3c</Background>
      <Foreground>#ffffff</Foreground>
    </Active>
  </TaskListStyle>
  <MenuStyle>
    <Font>${FONT}</Font>
    <Background>#2e2e2e</Background>
    <Foreground>#e8e8e8</Foreground>
    <Active>
      <Background>#4a4a4a</Background>
      <Foreground>#ffffff</Foreground>
    </Active>
  </MenuStyle>
  <Desktops width="1" height="1"/>
  <FocusModel>click</FocusModel>
  <MoveMode>opaque</MoveMode>
  <ResizeMode>opaque</ResizeMode>
  <Key mask="A" key="Tab">nextstacked</Key>
  <Key mask="A" key="F4">close</Key>
</JWM>
`
}
