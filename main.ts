// main.ts is mend, the CLI SPEC.md specifies (Node 22, standard library alone).
// Run as `node main.ts [options] [PATCH]`. Implements SPEC.md sections 1-10:
// CLI, output/exit codes, safe paths, format detection, three-tier line
// matching, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits,
// order and atomicity. In a trial the grader runs `node /bot/main.ts` with
// MAKEFUN_ENV_URL set, and this file hands over to runner.ts (last lines):
// keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------- files: lines, line break, final break (SPEC section 3) ----------

interface FileModel {
  lines: string[];
  br: string;
  ends: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const ends = text.endsWith(br);
  if (ends) lines.pop();
  return { lines, br, ends };
}

function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// ---------- three-tier matching (SPEC section 5) ----------

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function linesMatch(fileLine: string, oLine: string, tier: number): boolean {
  return normLine(fileLine, tier) === normLine(oLine, tier);
}

function findTier(
  fileLines: string[],
  o: string[],
  strict: boolean,
  start: number,
  endOnly: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = start; i + o.length <= fileLines.length; i++) {
      if (endOnly && i + o.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (!linesMatch(fileLines[i + j]!, o[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function findSingle(
  fileLines: string[],
  anchor: string,
  strict: boolean,
  start: number,
): { tier: number; pos: number } | null {
  const found = findTier(fileLines, [anchor], strict, start, false);
  if (found === null) return null;
  return { tier: found.tier, pos: found.positions[0]! };
}

// N entries: text, and ctx = index into O for a context line, else null.
interface NEntry {
  text: string;
  ctx: number | null;
  noNL: boolean;
}

function reindent(line: string, fileFirst: string, oFirst: string): string {
  if (line === '' || line.trim() === '') return line;
  const f = leadingWs(fileFirst);
  const p = leadingWs(oFirst);
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

function buildReplacement(
  fileLines: string[],
  pos: number,
  o: string[],
  n: NEntry[],
  tier: number,
): string[] {
  const out = fileLines.slice(0, pos);
  for (const e of n) {
    if (e.ctx !== null) out.push(fileLines[pos + e.ctx]!);
    else if (tier === 2) out.push(reindent(e.text, fileLines[pos]!, o[0]!));
    else out.push(e.text);
  }
  out.push(...fileLines.slice(pos + o.length));
  return out;
}

// Body entries (unified hunks / V4A chunks): context, old and new lines.
interface BodyEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNL: boolean;
}

function buildON(entries: BodyEntry[]): { o: string[]; n: NEntry[] } {
  const o: string[] = [];
  const n: NEntry[] = [];
  for (const e of entries) {
    if (e.kind === 'ctx') {
      const idx = o.length;
      o.push(e.text);
      n.push({ text: e.text, ctx: idx, noNL: e.noNL });
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else {
      n.push({ text: e.text, ctx: null, noNL: e.noNL });
    }
  }
  return { o, n };
}

// ---------- format detection (SPEC section 4) ----------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- JSON edits (SPEC section 9; starter code, kept) ----------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, serializeFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- unified diffs (SPEC section 6) ----------

interface Hunk {
  a: number;
  entries: BodyEntry[];
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  gitOld: string | null;
  gitNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseHunkBody(lines: string[], start: number): { entries: BodyEntry[]; next: number } {
  const entries: BodyEntry[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '') {
      entries.push({ kind: 'ctx', text: '', noNL: false });
      j++;
    } else if (l[0] === ' ') {
      entries.push({ kind: 'ctx', text: l.slice(1), noNL: false });
      j++;
    } else if (l[0] === '-') {
      entries.push({ kind: 'old', text: l.slice(1), noNL: false });
      j++;
    } else if (l[0] === '+') {
      entries.push({ kind: 'new', text: l.slice(1), noNL: false });
      j++;
    } else if (l[0] === '\\') {
      if (entries.length > 0) entries[entries.length - 1]!.noNL = true;
      j++;
    } else {
      break;
    }
  }
  // Empty lines at the end of a body are not part of it.
  while (entries.length > 0) {
    const last = entries[entries.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') entries.pop();
    else break;
  }
  return { entries, next: j };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): FileModel {
  const f = parseFile(text);
  let d = 0;
  for (const hunk of hunks) {
    const { o, n } = buildON(hunk.entries);
    if (o.length === 0) {
      const insertPos = Math.min(Math.max(hunk.a + d, 0), f.lines.length);
      const added = n.map((e) => e.text);
      if (insertPos === f.lines.length && added.length > 0) {
        f.ends = !n[n.length - 1]!.noNL;
      }
      f.lines = [...f.lines.slice(0, insertPos), ...added, ...f.lines.slice(insertPos)];
      d += n.length;
    } else {
      const found = findTier(f.lines, o, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const atEnd = best + o.length === f.lines.length;
      f.lines = buildReplacement(f.lines, best, o, n, found.tier);
      if (atEnd) f.ends = n.length === 0 ? true : !n[n.length - 1]!.noNL;
      d += n.length - o.length;
    }
  }
  return f;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let current: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  const newSection = (): UnifiedSection => {
    const s: UnifiedSection = {
      oldPath: null,
      newPath: null,
      gitOld: null,
      gitNew: null,
      renameFrom: null,
      renameTo: null,
      isNew: false,
      isDel: false,
      hunks: [],
    };
    sections.push(s);
    current = s;
    inHeader = true;
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i++;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (current !== null && inHeader) {
        current.oldPath = headerPath(line);
        current.newPath = headerPath(lines[i + 1]!);
        i += 2;
      } else {
        const s = newSection();
        s.oldPath = headerPath(line);
        s.newPath = headerPath(lines[i + 1]!);
        i += 2;
      }
    } else if (line.startsWith('--- ')) {
      if (current !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
    } else if (line.startsWith('@@')) {
      if (current === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = parseHunkBody(lines, i + 1);
      current.hunks.push({ a: parseInt(m[1]!, 10), entries: body.entries });
      inHeader = false;
      i = body.next;
    } else if (current !== null && inHeader) {
      if (line.startsWith('rename from ')) current.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) current.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) current.isNew = true;
      else if (line.startsWith('deleted file mode')) current.isDel = true;
      i++;
    } else {
      i++;
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    const oldP = sec.oldPath ?? sec.renameFrom ?? sec.gitOld;
    const newP = sec.newPath ?? sec.renameTo ?? sec.gitNew;
    const isCreation = oldP === '/dev/null' || sec.isNew;
    const isDeletion = newP === '/dev/null' || sec.isDel;
    return (tree: Tree): void => {
      if (oldP !== null && oldP !== '/dev/null' && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && newP !== '/dev/null' && !safe(newP)) throw new Fail('unsafe', newP);
      if (isCreation) {
        const np = newP!;
        if (tree.get(np) !== null) throw new Fail('exists', np);
        // Only '+' lines count for a creation.
        const plusLines: BodyEntry[] = [];
        for (const h of sec.hunks) {
          for (const e of h.entries) if (e.kind === 'new') plusLines.push(e);
        }
        const ls = plusLines.map((e) => e.text);
        const ends = ls.length > 0 ? !plusLines[plusLines.length - 1]!.noNL : false;
        tree.now.set(np, serializeFile({ lines: ls, br: '\n', ends }));
        return;
      }
      if (isDeletion) {
        const op = oldP!;
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      if (oldP !== null && newP !== null && oldP !== newP) {
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const result = applyHunks(tree.get(oldP)!, sec.hunks, strict, oldP);
        tree.now.set(newP, serializeFile(result));
        tree.now.set(oldP, null);
        tree.moves.push([oldP, newP]);
        return;
      }
      const p = (oldP ?? newP)!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      const result = applyHunks(tree.get(p)!, sec.hunks, strict, p);
      tree.now.set(p, serializeFile(result));
    };
  });
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let j = s + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======' && lines[j]!.trimEnd() !== '<<<<<<< SEARCH') j++;
    if (j >= lines.length || lines[j]!.trimEnd() !== '=======') throw new Exit2(`error: parse ${s + 1}`);
    const sep = j;
    let k = sep + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE' && lines[k]!.trimEnd() !== '<<<<<<< SEARCH') k++;
    if (k >= lines.length || lines[k]!.trimEnd() !== '>>>>>>> REPLACE') throw new Exit2(`error: parse ${s + 1}`);
    const end = k;
    let path: string | null = null;
    for (let t = s - 1; t > prevEnd; t--) {
      if (blank(lines[t]!)) continue;
      if (lines[t]!.trim().startsWith('```')) continue;
      path = lines[t]!.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    blocks.push({ path, oldLines: lines.slice(s + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    return (tree: Tree): void => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
        return;
      }
      const text = tree.get(b.path);
      if (text === null) throw new Fail('missing', b.path);
      const f = parseFile(text);
      const found = findTier(f.lines, b.oldLines, strict, 0, false);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
      const n: NEntry[] = b.newLines.map((t) => ({ text: t, ctx: null, noNL: false }));
      f.lines = buildReplacement(f.lines, found.positions[0]!, b.oldLines, n, found.tier);
      tree.now.set(b.path, serializeFile(f));
    };
  });
}

// ---------- V4A patches (SPEC section 8) ----------

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  entries: BodyEntry[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = (() => {
    let l = lines.length - 1;
    while (l >= 0 && blank(lines[l]!)) l--;
    return l;
  })();
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  interface RawSection {
    kind: 'add' | 'delete' | 'update';
    path: string;
    headerIdx: number;
    raw: Array<{ line: string; idx: number }>;
  }
  const sections: RawSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    if (!isSectionStart(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      path = line.slice('*** Add File:'.length).trim();
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = line.slice('*** Delete File:'.length).trim();
    } else {
      kind = 'update';
      path = line.slice('*** Update File:'.length).trim();
    }
    const headerIdx = i;
    i++;
    const raw: Array<{ line: string; idx: number }> = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      raw.push({ line: lines[i]!, idx: i });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
    sections.push({ kind, path, headerIdx, raw });
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  for (const sec of sections) {
    if (sec.kind === 'add') {
      const fileLines: string[] = [];
      for (const r of sec.raw) {
        if (r.line === '') fileLines.push('');
        else if (r.line.startsWith('+')) fileLines.push(r.line.slice(1));
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      const p = sec.path;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      });
    } else if (sec.kind === 'delete') {
      for (const r of sec.raw) {
        if (!blank(r.line)) throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      const p = sec.path;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      // update
      let raw = sec.raw;
      let moveTo: string | null = null;
      if (raw.length > 0 && raw[0]!.line.startsWith('*** Move to:')) {
        moveTo = raw[0]!.line.slice('*** Move to:'.length).trim();
        raw = raw.slice(1);
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      for (const r of raw) {
        const l = r.line;
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, entries: [] };
          chunks.push(cur);
        } else if (l === '*** End of File') {
          if (cur === null) {
            const c: V4AChunk = { anchor: null, eof: true, entries: [] };
            chunks.push(c);
          } else {
            cur.eof = true;
            cur = null;
          }
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, eof: false, entries: [] };
              chunks.push(cur);
            } else {
              throw new Exit2(`error: parse ${r.idx + 1}`);
            }
          }
          if (l === '') cur.entries.push({ kind: 'ctx', text: '', noNL: false });
          else if (l[0] === ' ') cur.entries.push({ kind: 'ctx', text: l.slice(1), noNL: false });
          else if (l[0] === '-') cur.entries.push({ kind: 'old', text: l.slice(1), noNL: false });
          else cur.entries.push({ kind: 'new', text: l.slice(1), noNL: false });
        } else {
          throw new Exit2(`error: parse ${r.idx + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.headerIdx + 1}`);
      const p = sec.path;
      const mt = moveTo;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const text = tree.get(p);
        if (text === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const f = parseFile(text);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            const a = findSingle(f.lines, chunk.anchor, strict, cursor);
            if (a === null) throw new Fail('no-match', p);
            cursor = a.pos + 1;
          }
          const { o, n } = buildON(chunk.entries);
          if (o.length === 0) {
            const insertPos = chunk.eof ? f.lines.length : cursor;
            const added = n.map((e) => e.text);
            f.lines.splice(insertPos, 0, ...added);
            cursor = insertPos + n.length;
          } else {
            const found = findTier(f.lines, o, strict, cursor, chunk.eof);
            if (found === null) throw new Fail('no-match', p);
            const pos = found.positions[0]!;
            f.lines = buildReplacement(f.lines, pos, o, n, found.tier);
            cursor = pos + n.length;
          }
        }
        const result = serializeFile(f);
        if (mt !== null) {
          tree.now.set(mt, result);
          tree.now.set(p, null);
          tree.moves.push([p, mt]);
        } else {
          tree.now.set(p, result);
        }
      });
    }
  }
  return edits;
}

// ---------- run (SPEC sections 1, 2, 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: A/D/M by path, R by <new>, all in byte order of the sort key.
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  const seenMoves = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const mk = `${oldP}\0${newP}`;
    if (seenMoves.has(mk)) continue;
    seenMoves.add(mk);
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!consumed.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
