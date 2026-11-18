// Publish the shared Retro TV engine with a desktop-browser presentation.
// The Electron application, local media, and private settings are not published.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist-web');
const mobile = path.join(root, 'dist-mobile');
const built = cp.spawnSync(process.execPath, [path.join(__dirname, 'build-mobile.js')], { cwd: root, stdio: 'inherit', timeout: 180000 });
if (built.status !== 0 || !fs.existsSync(path.join(mobile, 'index.html'))) {
  console.error('Unable to assemble website from PC source. Aborting instead of publishing broken files.');
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(mobile, out, { recursive: true });
fs.copyFileSync(path.join(root, 'web', 'desktop.css'), path.join(out, 'desktop.css'));
fs.copyFileSync(path.join(root, 'web', 'desktop.js'), path.join(out, 'desktop.js'));
const html = path.join(out, 'index.html');
let page = fs.readFileSync(html, 'utf8');
page = page.replace('</head>', '  <link rel="stylesheet" href="desktop.css">\n</head>');
page = page.replace('</body>', '  <script src="desktop.js"></script>\n</body>');
fs.writeFileSync(html, page);
// Existing mobile service worker precache doesn't include the new desktop assets;
// cache-bust the service-worker version to ensure updated shells after deployment.
const sw = path.join(out, 'sw.js');
if (fs.existsSync(sw)) {
  const text = fs.readFileSync(sw, 'utf8');
  // Keep the service worker from serving an old cached HTML shell.
  fs.writeFileSync(sw, text.replace(/(['"])\.\/index\.html\1/g, '$&'));
}
console.log('Built browser desktop application into dist-web');
