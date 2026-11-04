# PDF Studio

A desktop PDF editor for Windows (Electron). Edit text, sign, annotate, and organise pages — everything runs locally; your files never leave your computer.

## Run it

Requires [Node.js 18+](https://nodejs.org).

```powershell
cd pdf-studio
npm install        # also copies the PDF libraries into renderer/vendor
npm start          # launch the app
```

## Build the Windows installer

```powershell
npm run dist
```

Output goes to `dist/`: an installer (`PDF Studio Setup 1.0.0.exe`) and a portable `.exe`.
The installer registers PDF Studio as an available "Open with" app for `.pdf` files.

## Features

| Area | What you can do |
|---|---|
| **Edit text** | *Edit text* tool: click any line of existing text and retype it. *Add text* tool: click anywhere and type. Font, size, bold, italic, colour. |
| **Sign** | Draw, type (script fonts) or upload an image of your signature (white background removed automatically). Signatures can be saved and reused. Move and resize after placing. |
| **Annotate** | Highlight, freehand draw, rectangle, ellipse, line, arrow, whiteout. Colours, line width, fill. |
| **Images** | Insert PNG/JPG/GIF/WebP; move and resize. |
| **Pages** | Thumbnails sidebar: rotate, delete, reorder (drag & drop or ↑/↓), insert blank page, insert pages from another PDF (merge), extract selected pages to a new PDF (split). Ctrl/Shift-click to multi-select. |
| **Navigate** | Zoom (Ctrl +/−/0, Ctrl+wheel), fit width, find text (Ctrl+F), drag & drop a PDF onto the window. |
| **Editing safety** | Unlimited undo/redo (Ctrl+Z / Ctrl+Y), unsaved-changes prompt, Save never overwrites until you choose a file name the first time. |

### Shortcuts
`Ctrl+O` open · `Ctrl+S` save · `Ctrl+Shift+S` save as · `Ctrl+Z/Y` undo/redo · `Ctrl+D` duplicate · `Del` delete · arrows nudge selection (Shift = 10×)
Tools: `V` select · `E` edit text · `T` add text · `S` sign · `I` image · `H` highlight · `P` draw · `R` rect · `O` ellipse · `L` line · `A` arrow · `W` whiteout

## Good to know (limitations)

- **Whiteout / Edit text hide, they don't delete.** The original text stays inside the PDF underneath the cover (copy/search/extraction can still find it). Don't use it to redact sensitive information.
- **Edited text uses a standard or system font**, not the PDF's original embedded font, so it may look slightly different. Colour and size are matched automatically; bold/italic can be set manually.
- **Only horizontal text can be edited** (text on pages rotated 90°/270° is searchable but not click-editable).
- **Arabic / complex scripts:** characters outside Latin are drawn using a Windows font (Segoe UI/Arial/Tahoma, whichever is installed) but there is no right-to-left shaping, so Arabic letters will not join correctly. Use an image/signature for those.
- Password-protected PDFs and fillable form fields are not supported yet.
- Page operations (rotate, delete, reorder, insert) permanently apply any annotations you have added so far (they become part of the page; Undo still works).

## Project layout

```
main.js        Electron main process (windows, file dialogs, Windows font access)
preload.js     Safe bridge between UI and main process
renderer/      The editor UI (index.html, styles.css, app.js) + vendor/ libraries
scripts/       vendor.js copies pdf.js / pdf-lib / fontkit into renderer/vendor
build/icon.png App icon
```

Built with [pdf.js](https://mozilla.github.io/pdf.js/) (rendering) and [pdf-lib](https://pdf-lib.js.org/) (writing the edited PDF).
