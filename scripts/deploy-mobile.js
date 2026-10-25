// Builds the phone app and publishes it to GitHub Pages (github.com/<owner>/retro-tv-mobile).
// Only dist-mobile/ is published: app code and the channel lineup, never videos or the PIN.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPO = process.env.RTV_PAGES_REPO || 'alienheadbill/retro-tv-mobile';
const WORK = path.join(ROOT, '.deploy', 'retro-tv-mobile');
const DIST = path.join(ROOT, 'dist-mobile');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: WORK, ...opts });

// Optional "What's new" note for this release:
//   node scripts/deploy-mobile.js "Title" "One change" "Another change"
// adds an entry to the top of mobile/changelog.json; phones show it once after updating.
const [title, ...changes] = process.argv.slice(2);
if (title) {
  const file = path.join(ROOT, 'mobile', 'changelog.json');
  const log = JSON.parse(fs.readFileSync(file, 'utf8'));
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  log.unshift({ date, title, changes });
  fs.writeFileSync(file, JSON.stringify(log, null, 2) + '\n');
  console.log(`Added to What's new: ${title}`);
}

execFileSync(process.execPath, [path.join(__dirname, 'build-mobile.js')], { stdio: 'inherit' });

if (!fs.existsSync(path.join(WORK, '.git'))) {
  fs.mkdirSync(path.dirname(WORK), { recursive: true });
  execFileSync('gh', ['repo', 'clone', REPO, WORK], { stdio: 'inherit' });
}

// Replace the published files with the new build (the .git folder stays).
for (const f of fs.readdirSync(WORK)) if (f !== '.git') fs.rmSync(path.join(WORK, f), { recursive: true, force: true });
fs.cpSync(DIST, WORK, { recursive: true });

run('git', ['add', '-A']);
const changed = execFileSync('git', ['status', '--porcelain'], { cwd: WORK }).toString().trim();
if (!changed) {
  console.log('Nothing changed; already published.');
  process.exit(0);
}
const version = /"version": "(\d+)"/.exec(fs.readFileSync(path.join(DIST, 'config.js'), 'utf8'))[1];
run('git', ['commit', '-m', `Publish Retro TV phone app ${version}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`]);
run('git', ['branch', '-M', 'main']);
run('git', ['push', '-u', 'origin', 'main']);
console.log(`Published. Phones pick it up the next time the app is opened (GitHub Pages can take a minute or two).`);
