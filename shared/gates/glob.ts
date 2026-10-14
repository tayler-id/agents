// Path globs as policies write them, matched against repo-relative paths with
// forward slashes. `**` spans folders, `*` and `?` stay inside one.

const SPECIAL = /[.+^${}()|[\]\\]/g

export function globRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const rest = glob.slice(i)
    if (rest.startsWith('**/')) {
      source += '(?:.*/)?'
      i += 2
    } else if (rest === '/**') {
      source += '(?:/.*)?'
      i += 2
    } else if (rest.startsWith('**')) {
      source += '.*'
      i += 1
    } else if (rest.startsWith('*')) {
      source += '[^/]*'
    } else if (rest.startsWith('?')) {
      source += '[^/]'
    } else {
      source += rest.charAt(0).replace(SPECIAL, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

export function matcher(globs: readonly string[]): (path: string) => boolean {
  const patterns = globs.map(globRegExp)
  return (path) => patterns.some((p) => p.test(path))
}
