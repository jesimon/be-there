// Fetches the files live captions need (about 49 MB) into the folder the
// server serves them from, and checks every one against the list in
// lib/captions-files.js. Run with `npm run captions:fetch`.
//
// The server does the same by itself when it starts, so this is for a
// developer's machine, for fetching ahead of time, and for seeing what goes
// wrong when a download fails. Safe to run again: files that are already
// there and pass their checksum are kept.
//
// The folder is CAPTIONS_DIR, or "captions/<version>" beside the data file
// (DATA_FILE, by default data/db.json). A folder given as the first argument
// is used instead.
import { CAPTIONS_FILES, captionsDirFrom, captionsStatus, fetchCaptionsFiles } from '../lib/captions-files.js';

const dir = process.argv[2] ? captionsDirFrom({ CAPTIONS_DIR: process.argv[2] }) : captionsDirFrom(process.env);
const mb = (bytes) => (bytes / 1_000_000).toFixed(1);

if (captionsStatus(dir) === 'ready') {
  console.log(`The captions files are already in ${dir}. Checking them again…`);
} else {
  console.log(`Fetching the captions files into ${dir} (${CAPTIONS_FILES.length} files)…`);
}

let lastShown = -1;
const result = await fetchCaptionsFiles(dir, {
  onProgress({ loaded, total }) {
    const tenth = Math.floor((loaded / total) * 10);
    if (tenth !== lastShown) { lastShown = tenth; console.log(`  ${mb(loaded)} of ${mb(total)} MB`); }
  },
});

if (result.ok && captionsStatus(dir) === 'ready') {
  console.log(`Done: every file is there and matches its checksum (${result.fetched.length} fetched, ${CAPTIONS_FILES.length - result.fetched.length} already there).`);
} else {
  console.error('Not done. These could not be fetched or did not match the list:');
  for (const { path, reason } of result.failed) console.error(`  ${path || '(the folder itself)'}: ${reason}`);
  console.error('Nothing wrong was kept. Run this again to carry on from here.');
  process.exitCode = 1;
}
