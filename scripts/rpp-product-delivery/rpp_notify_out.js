const fs = require('fs');
const path = require('path');

function getOutPath() {
  const arg = process.argv.find(a => a.startsWith('--out='));
  if (!arg) return null;
  const p = arg.slice('--out='.length);
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

async function emit(message, sendFn, opts = {}) {
  const outPath = getOutPath();
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const summary = opts.summary ? `#SUMMARY: ${opts.summary}\n` : '';
    fs.writeFileSync(outPath, summary + message.trimEnd() + '\n', 'utf8');
    return { mode: 'file', path: outPath };
  }
  await sendFn();
  return { mode: 'send' };
}

module.exports = { getOutPath, emit };
