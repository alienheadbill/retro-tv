'use strict';
// Tailscale Funnel: a free public https address for the home server, through Tailscale's own app
// (tailscale.com/download). Turning it on runs `tailscale funnel --bg <port>`; the address is this
// computer's Tailscale name, e.g. https://my-laptop.tail1234.ts.net/.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function findTailscale() {
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Tailscale', 'tailscale.exe'),
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function run(bin, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() });
    });
  });
}

// The one-time "allow Funnel on your tailnet" page Tailscale asks for.
const approvalLink = (text) => (/(https:\/\/login\.tailscale\.com\/\S+)/.exec(text || '') || [])[1] || null;

async function status(port) {
  const bin = findTailscale();
  if (!bin) return { installed: false };
  const st = await run(bin, ['status', '--json']);
  let self = null;
  let running = false;
  try {
    const j = JSON.parse(st.out.slice(st.out.indexOf('{')));
    running = j.BackendState === 'Running';
    self = j.Self || null;
  } catch {}
  const host = self && self.DNSName ? self.DNSName.replace(/\.$/, '') : null;
  let on = false;
  if (running && host) {
    const fr = await run(bin, ['funnel', 'status', '--json']);
    try {
      const cfg = JSON.parse(fr.out.slice(fr.out.indexOf('{')));
      const web = (cfg.Web || {})[`${host}:443`];
      const proxy = web && web.Handlers && web.Handlers['/'] && web.Handlers['/'].Proxy;
      on = !!(cfg.AllowFunnel && cfg.AllowFunnel[`${host}:443`]) && !!proxy && proxy.endsWith(`:${port}`);
    } catch {}
  }
  return { installed: true, signedIn: running, host, url: host ? `https://${host}/` : null, on };
}

async function enable(port) {
  const bin = findTailscale();
  if (!bin) throw new Error("Tailscale isn't installed. Get it free at tailscale.com/download, sign in, then try again.");
  // The first time, Tailscale waits for you to allow Funnel in your account; it prints the link.
  const r = await run(bin, ['funnel', '--bg', String(port)], 20000);
  const link = approvalLink(r.out);
  if (link) return { needsApproval: link };
  if (!r.ok) throw new Error(r.out.split('\n').pop() || "Tailscale couldn't turn sharing on");
  return { ok: true };
}

async function disable() {
  const bin = findTailscale();
  if (!bin) return { ok: true };
  const r = await run(bin, ['funnel', '--https=443', 'off']);
  if (!r.ok) await run(bin, ['funnel', 'reset']);
  return { ok: true };
}

module.exports = { findTailscale, status, enable, disable, approvalLink };
