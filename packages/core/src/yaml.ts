/**
 * Minimal YAML subset parser, dependency-free.
 *
 * Supports the shapes a Waypoint config actually uses: nested mappings,
 * block and inline sequences, scalars, quoted strings, comments, and empty
 * values. Anchors, multi-document streams, flow mappings beyond simple
 * inline sequences, and block scalars are intentionally unsupported and
 * raise a clear error rather than parsing incorrectly.
 */

export class YamlError extends Error {
  constructor(message: string, readonly line?: number) {
    super(message);
    this.name = 'YamlError';
  }
}

interface Line {
  indent: number;
  text: string;
  lineNumber: number;
}

/** Strip a trailing comment, respecting quotes. */
function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function toLines(text: string): Line[] {
  const lines: Line[] = [];
  const all = text.split(/\r?\n/);

  for (let i = 0; i < all.length; i += 1) {
    const raw = all[i] ?? '';
    const withoutComment = stripComment(raw);

    if (withoutComment.trim() === '') continue;
    // A document separator means there is more than one document, which we
    // do not support.
    if (withoutComment.trim() === '---') {
      if (lines.length > 0) {
        throw new YamlError('Multiple YAML documents are not supported', i + 1);
      }
      continue;
    }
    if (withoutComment.trim() === '...') continue;

    if (/\t/.test(withoutComment.slice(0, withoutComment.length - withoutComment.trimStart().length))) {
      throw new YamlError('Tabs are not allowed for indentation', i + 1);
    }

    lines.push({
      indent: withoutComment.length - withoutComment.trimStart().length,
      text: withoutComment.trim(),
      lineNumber: i + 1,
    });
  }

  return lines;
}

/** Locate the `: ` (or trailing `:`) that separates key from value. */
function findKeySeparator(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return -1;
    if (ch === '[' || ch === '{') return -1;
    if (ch === ':' && (i + 1 === text.length || text[i + 1] === ' ')) return i;
  }
  return -1;
}

function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = text.slice(1, -1);
      return first === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
    }
  }
  return text;
}

export function parseScalar(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return '';

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return unquote(trimmed);
  }

  if (trimmed === 'true' || trimmed === 'True') return true;
  if (trimmed === 'false' || trimmed === 'False') return false;
  if (trimmed === 'null' || trimmed === '~') return null;

  if (/^[-+]?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return [];
    return splitInline(inner).map((item) => parseScalar(item));
  }

  if (trimmed.startsWith('|') || trimmed.startsWith('>')) {
    throw new YamlError('Block scalars are not supported');
  }

  if (trimmed.startsWith('&') || trimmed.startsWith('*')) {
    throw new YamlError('Anchors and aliases are not supported');
  }

  return trimmed;
}

/** Split an inline collection on commas that are not inside quotes or brackets. */
function splitInline(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') {
        if (i + 1 < text.length) current += text[i + 1];
        i += 1;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

class Parser {
  private index = 0;

  constructor(private readonly lines: Line[]) {}

  /** Package-visible so the module-level entry point can check for leftovers. */
  peek(): Line | undefined {
    return this.lines[this.index];
  }

  parseNode(minIndent: number): unknown {
    const first = this.peek();
    if (!first || first.indent < minIndent) return {};

    if (first.text.startsWith('- ') || first.text === '-') {
      return this.parseSequence(first.indent);
    }
    return this.parseMapping(first.indent);
  }

  private parseSequence(indent: number): unknown[] {
    const items: unknown[] = [];

    while (true) {
      const line = this.peek();
      if (!line || line.indent !== indent) break;
      if (!(line.text.startsWith('- ') || line.text === '-')) break;

      this.index += 1;
      const rest = line.text === '-' ? '' : line.text.slice(2).trim();

      if (rest === '') {
        // Nested block under the dash.
        const child = this.peek();
        if (child && child.indent > indent) {
          items.push(this.parseNode(child.indent));
        } else {
          items.push(null);
        }
        continue;
      }

      // "- key: value" starts a mapping whose first key sits on the dash line.
      const separator = findKeySeparator(rest);
      if (separator !== -1) {
        const inline: Record<string, unknown> = {};
        const key = unquote(rest.slice(0, separator).trim());
        const value = rest.slice(separator + 1).trim();

        if (value === '') {
          const child = this.peek();
          if (child && child.indent > indent) {
            inline[key] = this.parseNode(child.indent);
          } else {
            inline[key] = null;
          }
        } else {
          inline[key] = parseScalar(value);
        }

        // Absorb sibling keys indented past the dash.
        const rest2 = this.parseMappingInto(inline, indent + 2);
        Object.assign(inline, rest2);
        items.push(inline);
        continue;
      }

      items.push(parseScalar(rest));
    }

    return items;
  }

  private parseMapping(indent: number): Record<string, unknown> {
    return this.parseMappingInto({}, indent);
  }

  private parseMappingInto(
    target: Record<string, unknown>,
    indent: number,
  ): Record<string, unknown> {
    while (true) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      // A sequence entry at this level ends the mapping.
      if (line.text.startsWith('- ') || line.text === '-') break;
      if (line.indent > indent) {
        throw new YamlError(
          `Unexpected indentation (line ${line.lineNumber})`,
          line.lineNumber,
        );
      }

      const separator = findKeySeparator(line.text);
      if (separator === -1) {
        throw new YamlError(
          `Expected "key: value" but found "${line.text}"`,
          line.lineNumber,
        );
      }

      this.index += 1;

      const key = unquote(line.text.slice(0, separator).trim());
      const value = line.text.slice(separator + 1).trim();

      if (value === '') {
        const child = this.peek();
        if (child && child.indent > indent) {
          target[key] = this.parseNode(child.indent);
        } else if (child && child.indent === indent && child.text.startsWith('- ')) {
          // Sequence written at the same indent as its key.
          target[key] = this.parseSequence(indent);
        } else {
          target[key] = null;
        }
        continue;
      }

      target[key] = parseScalar(value);
    }

    return target;
  }
}

/** Parse a YAML document into plain JavaScript values. */
export function parseYaml(text: string): unknown {
  const lines = toLines(text);
  if (lines.length === 0) return {};

  const parser = new Parser(lines);
  const result = parser.parseNode(lines[0]?.indent ?? 0);

  const leftover = parser.peek();
  if (leftover) {
    throw new YamlError(
      `Unexpected content "${leftover.text}"`,
      leftover.lineNumber,
    );
  }

  return result;
}