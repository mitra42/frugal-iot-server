import toIco from 'to-ico';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function createFavicon() {
  try {
    // Read the PNG image
    const pngPath = path.join(__dirname, 'public/images/icon-192x192.png');
    const pngBuffer = fs.readFileSync(pngPath);

    // Convert PNG to ICO
    const icoBuffer = await toIco(pngBuffer);

    // Write the ICO file
    const icoPath = path.join(__dirname, 'public/favicon.ico');
    fs.writeFileSync(icoPath, icoBuffer);

    console.log('favicon.ico created successfully at ' + icoPath);
  } catch (error) {
    console.error('Error creating favicon:', error);
    process.exit(1);
  }
}

createFavicon();

