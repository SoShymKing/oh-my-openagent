export interface ExplicitSkillInvocation {
  readonly name: string
  readonly start: number
  readonly end: number
}

/** Match the host's leading skill run and explicit inline desktop skill tokens. */
export function explicitSkillInvocations(text: string): readonly ExplicitSkillInvocation[] {
  const tokens: ExplicitSkillInvocation[] = []
  const leading = /(?:\/skill:([a-zA-Z][a-zA-Z0-9:_-]*)|\$([a-zA-Z][a-zA-Z0-9:_-]*))(?=\s|$)/y
  let cursor = 0
  while (tokens.length < 64) {
    while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor += 1
    leading.lastIndex = cursor
    const match = leading.exec(text)
    const dollarName = match?.[2]
    const name = match?.[1] ?? (dollarName?.startsWith("skill:") ? dollarName.slice(6) : dollarName)
    if (match === null || name === undefined || name.length === 0) break
    tokens.push({ name, start: cursor, end: leading.lastIndex })
    cursor = leading.lastIndex
  }

  const inline = /(^|\s)\$skill:([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g
  inline.lastIndex = cursor
  for (const match of text.matchAll(inline)) {
    const name = match[2]
    if (name === undefined || tokens.length >= 64) break
    const start = match.index + (match[1]?.length ?? 0)
    tokens.push({ name, start, end: start + "$skill:".length + name.length })
  }
  return tokens
}
