// The design lint. Every color comes from the design tokens, an accent never
// touches a border, outline, ring or stroke, and nothing uses a gradient. It
// reads stylesheets, and inline styles and stroke attributes in components.

import ts from 'typescript'
import type { Finding } from '../framework.ts'
import { isScript, parseScript } from './source.ts'

export type CssRules = {
  // Custom properties the token stylesheet defines in its :root blocks.
  tokens: ReadonlySet<string>
  neutral: ReadonlySet<string>
}

// Properties that draw a line around or through something. Only neutral tokens may color them.
const LINE = /^(?:(?:border|outline)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|box-shadow|stroke|column-rule(?:-color)?)$/
// Properties that take a color.
const COLORED = /^(?:color|background(?:-color)?|text-shadow|fill|text-decoration(?:-color)?|caret-color|accent-color|scrollbar-color)$/
const HEX = /#[0-9a-f]{3,8}\b/i
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i
const GRADIENT = /\b(?:repeating-)?(?:linear|radial|conic)-gradient\(/i
const VAR = /var\(\s*--([\w-]+)/g
const NAMED_COLORS = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown '
  + 'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod '
  + 'darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen '
  + 'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue '
  + 'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew '
  + 'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan '
  + 'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray '
  + 'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid '
  + 'mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream '
  + 'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen '
  + 'paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown '
  + 'royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow '
  + 'springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '))

// The custom properties a stylesheet defines inside :root blocks.
export function tokensOf(css: string): Set<string> {
  const tokens = new Set<string>()
  for (const declaration of declarations(css)) {
    const name = /^--([\w-]+)$/.exec(declaration.property)?.[1]
    if (name && declaration.inRoot) tokens.add(name)
  }
  return tokens
}

type Declaration = { property: string; value: string; line: number; inRoot: boolean }

// Each `property: value` in a stylesheet, with the line it starts on and
// whether a :root block holds it. Comments are blanked first, keeping lines.
function declarations(css: string): Declaration[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
  const out: Declaration[] = []
  const selectors: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i)
    if (char !== '{' && char !== '}' && char !== ';') continue
    const chunk = text.slice(start, i)
    if (char === '{') {
      selectors.push(chunk.trim())
    } else {
      const colon = chunk.indexOf(':')
      if (colon > 0 && selectors.length) {
        const leading = chunk.length - chunk.trimStart().length
        out.push({
          property: chunk.slice(0, colon).trim().toLowerCase(),
          value: chunk.slice(colon + 1).trim(),
          line: text.slice(0, start + leading).split('\n').length,
          inRoot: selectors.some((s) => s.includes(':root')),
        })
      }
      if (char === '}') selectors.pop()
    }
    start = i + 1
  }
  return out
}

function valueFindings(path: string, line: number, property: string, value: string, rules: CssRules, defining: boolean): Finding[] {
  const out: Finding[] = []
  const at = (text: string) => out.push({ path, line, text })
  if (GRADIENT.test(value)) at(`a gradient in ${property}`)
  if (!defining && (HEX.test(value) || COLOR_FUNCTION.test(value))) at(`a color in ${property} that is not a design token`)
  const draws = LINE.test(property)
  if (!draws && !COLORED.test(property)) return out
  for (const word of value.replace(/var\([^)]*\)/g, ' ').toLowerCase().split(/[^a-z]+/)) {
    if (NAMED_COLORS.has(word)) at(`the color ${word} in ${property}, not a design token`)
    if (draws && word === 'currentcolor') at(`currentColor in ${property}, which can carry an accent`)
  }
  for (const match of value.matchAll(VAR)) {
    const token = match[1] ?? ''
    if (!rules.tokens.has(token)) at(`--${token} in ${property} is not a design token`)
    else if (draws && !rules.neutral.has(token)) at(`the accent --${token} in ${property}`)
  }
  return out
}

// Findings in a stylesheet. The token stylesheet's :root blocks may define
// tokens with raw colors, and nothing else may.
export function cssFindings(path: string, css: string, rules: CssRules): Finding[] {
  return declarations(css).flatMap((d) => valueFindings(path, d.line, d.property, d.value, rules, d.inRoot && d.property.startsWith('--')))
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

const stringOf = (node: ts.Expression | undefined): string | null =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null

// Findings in a component's inline styles and its SVG stroke and fill attributes.
export function componentFindings(path: string, source: string, rules: CssRules): Finding[] {
  if (!isScript(path)) return []
  const file = parseScript(path, source)
  const out: Finding[] = []
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text
      const init = node.initializer
      const expression = init && ts.isJsxExpression(init) ? init.expression : undefined
      if (name === 'style' && expression && ts.isObjectLiteralExpression(expression)) {
        for (const property of expression.properties) {
          if (!ts.isPropertyAssignment(property)) continue
          const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null
          const value = stringOf(property.initializer)
          if (key !== null && value !== null) out.push(...valueFindings(path, lineOf(property), kebab(key), value, rules, false))
        }
      } else if (name === 'stroke' || name === 'fill') {
        const value = init && ts.isStringLiteral(init) ? init.text : stringOf(expression)
        if (value !== null) out.push(...valueFindings(path, lineOf(node), name, value, rules, false))
      }
    }
    for (const child of node.getChildren(file)) visit(child)
  }
  visit(file)
  return out
}
