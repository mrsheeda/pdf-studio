// Copies browser builds of the libraries into renderer/vendor so the app has no runtime node_modules dependency.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(out, { recursive: true });
const files = [
  ['pdfjs-dist/build/pdf.min.js', 'pdf.min.js'],
  ['pdfjs-dist/build/pdf.worker.min.js', 'pdf.worker.min.js'],
  ['pdf-lib/dist/pdf-lib.min.js', 'pdf-lib.min.js'],
  ['@pdf-lib/fontkit/dist/fontkit.umd.min.js', 'fontkit.umd.min.js'],
];
for (const [src, dst] of files) {
  fs.copyFileSync(path.join(root, 'node_modules', src), path.join(out, dst));
  console.log('vendored', dst);
}
