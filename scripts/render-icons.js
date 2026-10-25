// Renders mobile/icon.svg to the PNG sizes iOS and Android want. Run with: npx electron scripts/render-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'mobile');
const svg = fs.readFileSync(path.join(root, 'icon.svg'), 'utf8');
const out = path.join(root, 'icons');

// Each size gets its own window; don't quit when one closes.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  for (const size of [180, 192, 512]) {
    const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
    const html = `<html><body style="margin:0;background:#14161b">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`;
    await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    fs.writeFileSync(path.join(out, `icon-${size}.png`), img.resize({ width: size, height: size }).toPNG());
    win.destroy();
  }
  app.quit();
});
