// First draft of SCRIPTS[id] from a transcript (.cache/transcripts/<id>.txt), to be checked by hand:
//   node scripts/video/draft-script.mjs <id> [route.json]
// Sat-nav prompts (TomTom never says "please") become 'S' lines with a guessed anchor; the
// examiner's words become 'E' lines; everything else (the instructor's commentary, music,
// greetings) is printed as a comment so nothing is lost. With a route file (default
// app/data/routes/cdi-<id>.json) road names are matched against the route's turns.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [id, routeFile = join(root, `app/data/routes/cdi-${id}.json`)] = process.argv.slice(2);
if (!id) { console.error('usage: node scripts/video/draft-script.mjs <id> [route.json]'); process.exit(1); }
const txt = readFileSync(join(root, `.cache/transcripts/${id}.txt`), 'utf8');
const roads = existsSync(routeFile)
  ? [...new Set(JSON.parse(readFileSync(routeFile, 'utf8')).route.steps.flatMap((s) => [s.name, ...(s.ref || '').split(';')]).filter(Boolean))]
  : [];
// captions often add or drop a plural s ("Northfields Avenue")
const norm = (s) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/s\b/g, '').replace(/\s+/g, ' ').trim();
const NARRATION = /\b(we|we'll|we're|our|us|i|i'm|i'll|you'll|let's|subscribe|channel|website|contact|lessons?|mock test|support)\b/i;

const SATNAV = /^(after (about )?[\d.,]+ ?(yards?|yd|miles?|mi|metres?|meters?|m)\b|turn (left|right)|keep (left|right)|bear (left|right)|go (left|right|straight)|take the (exit|\w+ exit)|cross the roundabout|at the (roundabout|end of the road)|then\b|you have reached|you('ve| have) arrived|continue|drive to|head (north|south|east|west)|make a u-turn)/i;
const EXAMINER = /\b(please|pull up|drive on|move off|when you('re| are) ready|independent driving|thank you|park(ing)?\b|reverse|follow the road ahead|next road on the|show me|tell me|engine|on the left (when|along|here))/i;

const out = [];
for (const line of txt.split('\n')) {
  const m = line.match(/^(\d+:\d\d) (.*)$/);
  if (!m) continue;
  const [, t, raw] = m;
  const text = raw.replace(/^>>\s*/, '').trim();
  const promo = /\b(subscribe|channel|website|contact|lessons?|mock test|support)\b/i.test(text);
  const satnav = SATNAV.test(text) && !/\bplease\b/i.test(text) && !NARRATION.test(text);
  const examiner = !satnav && !promo && EXAMINER.test(text) && text.split(' ').length <= 30;
  if (!satnav && !examiner) { out.push(`    // ${t} ${text}`); continue; }
  let anchor = '';
  if (satnav) {
    // the line is pinned to its first manoeuvre: "After 300 yards, turn left, X Road, then …"
    const first = text.split(/,?\s+then\b|\.\s+then\b/i)[0];
    const n = norm(first);
    const road = roads.find((r) => n.includes(norm(r)));
    const after = first.match(/^after (?:about )?([\d.,]+) ?(yards?|yd|miles?|mi)/i);
    const sel = road || (/roundabout/i.test(first) ? 'RB' : /take the exit/i.test(first) ? 'OFF' : /keep (left|right)/i.test(first) ? 'FORK'
      : /turn left/i.test(first) ? 'L' : /turn right/i.test(first) ? 'R' : '');
    if (sel) anchor = after ? `${sel}|${after[1].replace(',', '')}${/^m/i.test(after[2]) ? 'mi' : 'y'}` : sel;
  }
  const q = (s) => `"${s.replace(/"/g, '\\"')}"`;
  out.push(`    ['${t}', '${satnav ? 'S' : 'E'}', ${q(text)}${anchor ? `, '${anchor}'` : ''}],`);
}
console.log(`  ${/^\d/.test(id) ? `'${id}'` : id}: [\n${out.join('\n')}\n  ],`);
