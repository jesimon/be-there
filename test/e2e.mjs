// A real visit in two browsers with fake cameras: the home screen and a
// visitor. Run with `npm run e2e` (needs Playwright and Chromium installed).
// Set SHOTS=<folder> to save screenshots along the way.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../server.js';
import { createStore } from '../lib/store.js';

// Playwright is loaded with require so a globally installed copy works too.
const { chromium } = createRequire(import.meta.url)('playwright');

const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const snap = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

const srv = await startServer({ port: 0, store: createStore(':memory:'), setupPassword: '' });
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const step = (s) => console.log(`- ${s}`);

try {
  // The organizer sets up a home through the real setup page.
  const org = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await org.goto(`${srv.url}/setup`);
  await org.fill('input[name=personName]', 'Mary');
  await org.fill('input[name=start]', '00:00');
  await org.fill('input[name=end]', '23:59');
  await org.click('button[type=submit]');
  await org.waitForSelector('#done:not([hidden])');
  const homeLink = await org.textContent('#home-link');
  const orgLink = await org.textContent('#org-link');
  await snap(org, '1-setup-done');
  step('set up a home');

  // The organizer invites Sarah.
  await org.goto(orgLink);
  await org.waitForSelector('#content:not([hidden])');
  await org.fill('#invite input[name=name]', 'Sarah');
  await org.fill('#invite input[name=relation]', 'Granddaughter');
  await org.click('#invite button[type=submit]');
  await org.waitForSelector('#new-link:not([hidden])');
  const visitLink = await org.textContent('#new-url');
  await snap(org, '2-organizer');
  step('invited Sarah');

  // The home screen (a tablet in landscape).
  const homeCtx = await browser.newContext({ viewport: { width: 1180, height: 820 }, permissions: ['camera', 'microphone'] });
  const home = await homeCtx.newPage();
  await home.goto(homeLink);
  // The screen connects without a tap: the organizer sees it is on.
  await org.reload();
  await org.waitForFunction(() => document.querySelector('#online')?.textContent === 'Home screen is on');
  await home.click('#start');
  await home.waitForSelector('.person.pending');
  await snap(home, '3-home-asks-mary');
  step('home screen shows Sarah waiting for a yes');

  // Sarah's phone.
  const visitCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera', 'microphone'] });
  const visit = await visitCtx.newPage();
  await visit.goto(visitLink);
  await visit.waitForFunction(() => document.querySelector('#state')?.textContent.includes('Waiting for them'));
  assert.equal(await visit.isDisabled('#visit'), true, 'Sarah cannot visit before Mary says yes');
  step('Sarah cannot visit yet');

  // Mary says yes.
  await home.click('.person.pending .btn.yes');
  await visit.waitForFunction(() => !document.querySelector('#visit').disabled);
  await snap(home, '4-home-idle');
  await snap(visit, '5-visitor-lobby');
  step('Mary said yes');

  // Sarah knocks; Mary answers.
  await visit.click('#visit');
  await home.waitForSelector('#knock:not([hidden])');
  assert.match(await home.textContent('#knock-title'), /Sarah is here to see you/);
  await snap(home, '6-home-knock');
  await home.click('#answer');
  step('Sarah knocked and Mary answered');

  // Both see and hear each other: video frames arrive on both sides.
  const hasVideo = (page) => page.waitForFunction(() => {
    const v = document.querySelector('#remote');
    return v && v.videoWidth > 0 && v.readyState >= 2 && v.srcObject?.getAudioTracks().length > 0;
  }, null, { timeout: 20_000 });
  await Promise.all([hasVideo(home), hasVideo(visit)]);
  assert.match(await home.textContent('#with-you-text'), /Sarah is with you/);
  await home.waitForTimeout(800);
  await snap(home, '7-home-in-visit');
  await snap(visit, '8-visitor-in-visit');
  step('video and sound flow both ways; the home screen shows who is there');

  // Mary ends the visit; Sarah is told.
  await home.click('#end');
  await visit.waitForSelector('#lobby:not([hidden])');
  assert.match(await visit.textContent('#hint'), /ended/);
  assert.equal(await home.isVisible('#call'), false);
  // The camera is released on the home screen when the visit ends.
  assert.equal(await home.evaluate(() => document.querySelector('#local').srcObject), null);
  step('Mary ended the visit');

  // Drop-in: Mary lets Sarah come straight in; Mary still gets notice.
  await home.click('.person .btn.toggle');
  await visit.waitForFunction(() => document.querySelector('#visit').textContent === 'Visit now');
  await visit.click('#visit');
  await home.waitForSelector('#knock:not([hidden])');
  assert.match(await home.textContent('#knock-title'), /Sarah is coming in/);
  await snap(home, '9-home-dropin-notice');
  await Promise.all([hasVideo(home), hasVideo(visit)]);
  step('drop-in connected after the notice');

  // Mary pauses visits from the call? She ends it, then pauses.
  await home.click('#end');
  await home.click('#pause');
  await visit.waitForFunction(() => document.querySelector('#state').textContent.includes('paused'));
  assert.equal(await visit.isDisabled('#visit'), true);
  step('pausing stops visits');

  console.log('E2E passed');
} finally {
  await browser.close();
  await srv.close();
}
