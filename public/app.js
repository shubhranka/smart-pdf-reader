import { initLibrary, refresh } from './library.js';
import { initReader, openDocument, close } from './reader.js';

const libraryView = document.getElementById('library');

function showLibrary() {
  close();
  libraryView.hidden = false;
  refresh();
}

async function route() {
  const match = location.hash.match(/^#\/doc\/([a-f0-9]+)$/i);
  if (!match) return showLibrary();

  try {
    await openDocument(match[1]);
  } catch (err) {
    alert(err.message);
    location.hash = '';
  }
}

initLibrary((docId) => { location.hash = `#/doc/${docId}`; });
initReader(() => { location.hash = ''; });

window.addEventListener('hashchange', route);
route();
