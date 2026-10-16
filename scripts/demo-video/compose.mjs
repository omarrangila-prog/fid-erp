// Turns the recorded scene clips into one client demo video: title card, captioned
// scenes, closing card and a soft ambient bed.
//   node scripts/demo-video/compose.mjs <clipsDir> <out.mp4> [workDir]
// Brand text and logo come from the environment / public/brand, like the app itself:
//   PRODUCT_NAME (default AURQORA), PRODUCT_TAGLINE_VIDEO, PRODUCT_LOGO_REVERSE
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [clipsDir, outFile, workArg] = process.argv.slice(2);
const work = resolve(workArg ?? join(clipsDir, '..', 'work'));
mkdirSync(work, { recursive: true });
const NAME = process.env.PRODUCT_NAME || 'AURQORA';
const TAG = process.env.PRODUCT_TAGLINE_VIDEO || 'FROM PURCHASE TO PROFIT.';
const logoPath = resolve(process.env.PRODUCT_LOGO_REVERSE || 'public/brand/logo-reverse.svg');
const logoSvg = readFileSync(logoPath, 'utf8');
const SPEED = 1.2;
const W = 1920;
const H = 1080;

const scenes = [
  ['01-login', 'Sign in to a workspace built for global trade', 'One secure login. Your companies, your currencies.'],
  ['02-dashboard', 'Cash, receivables, payables and stock — at a glance', 'What needs attention, the moment you open it.'],
  ['03-purchase', 'Buy in any currency', 'Purchase orders keep the supplier price, the rate and the shipment together.'],
  ['04-shipments', 'Follow every shipment to its true landed cost', 'Freight, duty and clearing flow into the cost of the goods.'],
  ['05-stock', 'Stock on hand, valued at landed cost', 'By warehouse, batch and shipment — with profit beside it.'],
  ['06-invoice', 'Sell from a named batch', 'Every invoice knows exactly what it cost.'],
  ['07-receivables', 'Know who owes you, and since when', 'Customer balances in their own currency.'],
  ['08-profit', 'Profit by shipment, item and customer', 'Margin measured only on what has actually sold.'],
  ['09-reports', 'Books that are always balanced', 'Profit & loss and balance sheet, ready to share.'],
  ['10-multicompany', 'One login. Many companies. Many currencies.', 'Switch entity and the whole workspace follows.'],
  ['11-settings', 'Your company, your identity', 'Logo, address and registration on every document.'],
  ['12-mobile', 'The same books, on your phone', 'Check cash, stock and invoices from anywhere.'],
];

const base = `
  *{box-sizing:border-box;margin:0}
  body{width:${W}px;height:${H}px;font-family:Inter,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden}
  .lanes{position:absolute;inset:0;opacity:.28}
`;
const lanes = `<svg class="lanes" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice" fill="none"><g stroke="#c5a05a" stroke-width="1.2"><path d="M-60 900C400 800 800 560 1200 430S1760 250 2000 100"/><path d="M-60 1010C480 920 900 700 1300 560S1800 380 2000 260" opacity=".6"/><path d="M-60 780C300 660 700 480 1100 330S1700 120 2000 -20" opacity=".45"/></g><g fill="#c5a05a"><circle cx="1200" cy="430" r="5"/><circle cx="1300" cy="560" r="4" opacity=".7"/><circle cx="1100" cy="330" r="4" opacity=".6"/></g></svg>`;
const dark = `background:#0a1114;color:#f6f2e8;`;
const glow = `<div style="position:absolute;inset:0;background:radial-gradient(1100px 700px at 88% -8%,rgba(55,112,95,.5),transparent 62%),radial-gradient(800px 520px at -6% 108%,rgba(197,160,90,.16),transparent 60%)"></div>`;

const pages = {
  intro: `<style>${base}</style><body style="${dark}">${glow}${lanes}
    <div style="position:absolute;left:160px;top:330px"><div style="height:120px;display:flex;align-items:center">${logoSvg.replace('<svg', '<svg style="height:120px;width:auto"')}</div>
    <p style="margin-top:56px;font-size:92px;font-weight:600;letter-spacing:-.01em;line-height:1.02;max-width:1300px">${TAG}</p>
    <p style="margin-top:34px;font-size:30px;color:rgba(246,242,232,.62);letter-spacing:.01em">Global trade &amp; operations ERP — purchasing, shipments, landed cost, stock, sales and accounts in one system.</p></div></body>`,
  outro: `<style>${base}</style><body style="${dark}">${glow}${lanes}
    <div style="position:absolute;left:160px;top:300px;max-width:1400px"><p style="font-size:84px;font-weight:600;line-height:1.05;letter-spacing:-.01em">SEE YOUR ENTIRE TRADE OPERATION IN ONE SYSTEM.</p>
    <p style="margin-top:36px;font-size:32px;color:rgba(246,242,232,.68)">Purchase orders · Shipments · Landed cost · Stock · Sales · Payments · Profit · Reports</p>
    <div style="margin-top:64px;display:flex;align-items:center;gap:40px"><span style="display:inline-block;background:#f6f2e8;color:#0a1114;font-weight:600;font-size:30px;padding:20px 40px;border-radius:10px">Book a demo</span>
    <div style="height:64px">${logoSvg.replace('<svg', '<svg style="height:64px;width:auto"')}</div></div></div></body>`,
};
const caption = (title, sub) => `<style>${base}body{background:transparent}</style><body>
  <div style="position:absolute;left:0;right:0;bottom:0;height:300px;background:linear-gradient(to top,rgba(10,17,20,.88),rgba(10,17,20,.55) 55%,transparent)"></div>
  <div style="position:absolute;left:96px;bottom:70px;color:#f6f2e8;max-width:1500px">
    <div style="width:56px;height:3px;background:#c5a05a;margin-bottom:22px"></div>
    <p style="font-size:50px;font-weight:600;letter-spacing:-.015em;line-height:1.1">${title}</p>
    <p style="margin-top:12px;font-size:26px;color:rgba(246,242,232,.78)">${sub}</p></div></body>`;
const phoneBg = `<style>${base}</style><body style="${dark}">${glow}${lanes}</body>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
async function shot(name, html, transparent = false) {
  await page.setContent(html);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(work, `${name}.png`), omitBackground: transparent });
}
await shot('intro', pages.intro);
await shot('outro', pages.outro);
await shot('phone-bg', phoneBg);
for (const [id, t, s] of scenes) await shot(`cap-${id}`, caption(t, s), true);
await browser.close();

const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const segs = [];

function still(name, seconds) {
  const out = join(work, `${name}.mp4`);
  ff('-loop', '1', '-t', String(seconds), '-i', join(work, `${name}.png`),
    '-vf', `scale=${W}:${H},fade=t=in:st=0:d=0.8,fade=t=out:st=${seconds - 0.8}:d=0.8,format=yuv420p`,
    '-r', '30', '-c:v', 'libx264', '-crf', '18', out);
  return out;
}
segs.push(still('intro', 5));

for (const [id] of scenes) {
  const clip = join(clipsDir, `${id}.webm`);
  if (!existsSync(clip)) continue;
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip]).toString()) / SPEED;
  const out = join(work, `${id}.mp4`);
  const mobile = id === '12-mobile';
  const fade = `fade=t=in:st=0:d=0.5,fade=t=out:st=${(dur - 0.5).toFixed(2)}:d=0.5`;
  const capFade = `format=rgba,fade=t=in:st=0.6:d=0.5:alpha=1,fade=t=out:st=${(dur - 1.2).toFixed(2)}:d=0.5:alpha=1`;
  const filter = mobile
    ? `[1:v]setpts=PTS/${SPEED},scale=-2:960[ph];[0:v][ph]overlay=(W-w)/2:60[a];[2:v]${capFade}[c];[a][c]overlay=0:0,${fade},format=yuv420p`
    : `[0:v]setpts=PTS/${SPEED},scale=${W}:${H},fps=30[v];[1:v]${capFade}[c];[v][c]overlay=0:0,${fade},format=yuv420p`;
  const T = dur.toFixed(2);
  const inputs = mobile
    ? ['-loop', '1', '-framerate', '30', '-t', T, '-i', join(work, 'phone-bg.png'), '-i', clip]
    : ['-i', clip];
  ff(...inputs, '-loop', '1', '-framerate', '30', '-t', T, '-i', join(work, `cap-${id}.png`),
    '-filter_complex', filter, '-t', dur.toFixed(2), '-r', '30', '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-an', out);
  segs.push(out);
}
segs.push(still('outro', 6));

const list = join(work, 'list.txt');
writeFileSync(list, segs.map((s) => `file '${s}'`).join('\n'));
const silent = join(work, 'silent.mp4');
ff('-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent);
const total = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', silent]).toString());

// Ambient bed: slow, quiet, low-passed chord pad (A minor 9 voicing) with gentle tremolo.
const t = total.toFixed(2);
const pad = ['110', '164.81', '220', '246.94', '329.63']
  .map((f, i) => `sin(2*PI*${f}*t)*${(0.22 - i * 0.025).toFixed(3)}*(0.75+0.25*sin(2*PI*${(0.07 + i * 0.013).toFixed(3)}*t))`)
  .join('+');
const audio = join(work, 'bed.m4a');
ff('-f', 'lavfi', '-i', `aevalsrc='${pad}':s=44100:d=${t}`,
  '-af', `lowpass=f=900,aecho=0.8:0.7:420|640:0.35|0.25,volume=0.55,afade=t=in:st=0:d=3,afade=t=out:st=${(total - 4).toFixed(2)}:d=4`,
  '-c:a', 'aac', '-b:a', '160k', audio);
ff('-i', silent, '-i', audio, '-c:v', 'copy', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', resolve(outFile));
console.log(`${resolve(outFile)}  ${total.toFixed(1)}s`);
