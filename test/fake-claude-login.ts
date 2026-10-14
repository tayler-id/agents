// A stand-in for `claude setup-token`, for checks. It prints what the real CLI
// 2.1.296 prints under a terminal with no browser: words placed by cursor moves,
// the sign-in link as a terminal hyperlink on claude.com with a PKCE challenge
// and a state, then "Paste code here if prompted >". It reads keys the way the
// real CLI does, in raw mode. A code shaped <code>#<state> with this link's state gets a
// token that starts sk-ant-oat01-, printed with the real CLI's closing lines. A
// code whose first part is "refused" gets the real CLI's OAuth error.

import { randomBytes } from 'node:crypto'

const ESC = '\u001b'
const BEL = '\u0007'
// The real CLI moves the cursor to each word's column instead of printing spaces.
const placed = (text: string) => {
  let column = 2
  return text.split(' ').map((word) => {
    const move = `${ESC}[${column}G`
    column += word.length + 1
    return `${move}${word}`
  }).join('')
}
const line = (text: string) => `${placed(text)}\r\n`

export async function fakeSetupToken(): Promise<number> {
  const state = randomBytes(24).toString('base64url')
  const link = 'https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-fake-client&response_type=code'
    + `&redirect_uri=${encodeURIComponent('https://platform.claude.com/oauth/code/callback')}&scope=${encodeURIComponent('user:inference')}`
    + `&code_challenge=${randomBytes(32).toString('base64url')}&code_challenge_method=S256&state=${state}`
  const out = (text: string) => { process.stdout.write(text) }
  out(`${ESC}[?25l${line('Welcome to Claude Code v2.1.296')}\r\n`)
  out(line('This will guide you through long-lived (1-year) auth token setup for your Claude account. Claude subscription required.'))
  out(`\r\n${line("Browser didn't open? Use the url below to sign in (c to copy)")}\r\n`)
  out(`${ESC}]8;id=fake;${link}${BEL}${link}${ESC}]8;;${BEL}\r\n\r\n`)
  out(placed('Paste code here if prompted >'))

  if (!process.stdin.isTTY) {
    process.stderr.write('Raw mode is not supported on the current process.stdin\n')
    return 1
  }
  process.stdin.setRawMode(true)
  let typed = ''
  for await (const chunk of process.stdin) {
    // In raw mode with no encoding set, stdin gives bytes.
    if (!Buffer.isBuffer(chunk)) throw new Error('stdin gave something other than bytes')
    for (const key of chunk.toString('utf8')) {
      if (key !== '\r') {
        typed += key
        continue
      }
      const [code = '', given = ''] = typed.trim().split('#')
      typed = ''
      if (!code || given !== state) {
        out(`\r\n${line('OAuth error: Invalid code. Please make sure the full code was copied')}${line('Press Enter to retry.')}`)
        continue
      }
      if (code === 'refused') {
        out(`\r\n${line('OAuth error: Failed to exchange authorization code for access token. Please try again.')}${line('Press Enter to retry.')}`)
        continue
      }
      const token = `sk-ant-oat01-${randomBytes(70).toString('base64url')}`
      out(`\r\n${line('✓ Long-lived authentication token created successfully!')}\r\n`)
      out(line('Your OAuth token (valid for 1 year):'))
      out(`${ESC}[2G${ESC}[33m${token}${ESC}[39m\r\n\r\n`)
      out(line("Store this token securely. You won't be able to see it again."))
      out(line('Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>'))
      process.stdin.setRawMode(false)
      return 0
    }
  }
  return 1
}
