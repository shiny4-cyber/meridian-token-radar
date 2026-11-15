// Node >=22.18, standard library only. No runtime network or installation.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSnapshot, buildRadar } from './dashboard/model.mjs';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
function run() {
  const args = process.argv.slice(2);
  let input = '/input/snapshot.json';
  let preview = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1] && !args[i + 1].startsWith('--')) input = args[++i];
    else if (args[i] === '--preview') preview = true;
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  if (statSync(input).isDirectory()) input = join(input, 'snapshot.json');
  const snapshot = parseSnapshot(readFileSync(input, 'utf8'));
  const board = buildRadar(snapshot);
  const out = resolve(process.env.MAKEFUN_OUTPUT_DIR || '/output');
  if (out === root || out.startsWith(root + '/')) throw new Error('Keep generated output outside the source repository.');
  mkdirSync(out, { recursive: true });
  cpSync(join(root, 'dashboard'), join(out, 'dashboard'), { recursive: true });
  const bytes = JSON.stringify(board) + '\n';
  writeFileSync(join(out, 'board.json'), bytes);
  writeFileSync(join(out, 'dashboard', 'records.dat'), bytes);
  if (preview) {
    console.log(`Preview: ${board.rows.length} protocols, ${board.summary.watchlist} watchlist; no dossier until genuine browser captures exist.`);
    return;
  }
  const shots = join(root, 'screenshots');
  if (!existsSync(shots) || readdirSync(shots).filter(x => !x.startsWith('.')).length !== 3) throw new Error('Exactly three genuine screenshots are required; use --preview for first capture.');
  cpSync(shots, join(out, 'screenshots'), { recursive: true });
  const dossier = buildDossier(out, { text_max_bytes: 65536, screenshots: { max: 4, max_bytes: 524288 }, dashboard: { max_files: 400, max_bytes: 4194304 } });
  if (dossier.byteLength > 1572864) throw new Error('Dossier exceeds the competition 1.5 MiB cap');
  writeFileSync(join(out, 'dossier.json'), dossier);
  console.log(`Built ${board.rows.length} rows / ${board.summary.watchlist} watchlist / ${board.summary.research_candidates} research candidates. Dossier ${dossier.byteLength} bytes.`);
}
try { run(); } catch (error) { console.error(`Meridian build failed: ${error.message}`); process.exitCode = 1; }
