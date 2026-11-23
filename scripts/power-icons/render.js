const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const only = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  p.on('pageerror', e => console.log('pageerror', e.message));
  p.on('console', m => { if (m.type() === 'error') console.log('console', m.text()); });
  await p.goto('file://' + __dirname + '/render.html');
  await p.waitForFunction('window.ready === true', { timeout: 30000 });
  const ids = only.length ? only : await p.evaluate('window.ids');
  fs.mkdirSync('out', { recursive: true });
  for (const id of ids) {
    try {
      const data = await p.evaluate(i => window.renderIcon(i), id);
      fs.writeFileSync(`out/${id}.png`, Buffer.from(data.split(',')[1], 'base64'));
      console.log('ok', id);
    } catch (e) { console.log('FAIL', id, e.message.split('\n')[0]); }
  }
  await b.close();
})();
