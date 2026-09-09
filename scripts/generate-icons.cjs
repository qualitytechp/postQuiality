#!/usr/bin/env node
/**
 * Genera todos los iconos de la aplicación a partir de un único archivo fuente.
 *
 *   node scripts/generate-icons.cjs logo/qualitytech.svg
 *
 * Acepta SVG o PNG (cuadrado, 1024×1024 o mayor). Produce:
 *   assets/icon.png            512  — fuente que usa electron-builder
 *   assets/icon-{16..512}.png       — tamaños sueltos que consume el proyecto
 *   assets/icon.ico                 — Windows (varios tamaños en un archivo)
 *   assets/icons/                   — árbol hicolor para Linux
 *
 * `icon.icns` (macOS) no se genera aquí: requiere `iconutil`, que sólo existe
 * en macOS. En Windows y Linux el archivo anterior se deja intacto y se avisa.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const SIZES = [16, 32, 44, 64, 71, 128, 150, 256, 300, 512];
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
// Se lee del build para que el nombre del icono siga al id de la aplicación.
const APP_ID = require(path.join(ROOT, 'package.json')).build.appId;

async function main() {
  const source = process.argv[2];
  if (!source) {
    console.error('Uso: node scripts/generate-icons.cjs <ruta-del-logo.svg|png>');
    process.exit(1);
  }
  const sourcePath = path.resolve(ROOT, source);
  if (!fs.existsSync(sourcePath)) {
    console.error(`No existe el archivo: ${sourcePath}`);
    process.exit(1);
  }

  const meta = await sharp(sourcePath).metadata();
  if (meta.format !== 'svg' && (meta.width || 0) < 512) {
    console.error(`El origen mide ${meta.width}×${meta.height}; hace falta 512 o más (o un SVG).`);
    process.exit(1);
  }
  if (meta.format !== 'svg' && meta.width !== meta.height) {
    console.error(`El origen no es cuadrado (${meta.width}×${meta.height}).`);
    process.exit(1);
  }

  fs.mkdirSync(ASSETS, { recursive: true });

  // Renderizar desde el origen en cada tamaño da mejor resultado que reescalar
  // un PNG ya reducido, sobre todo en 16 y 32 píxeles.
  const render = (size) => sharp(sourcePath, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png();

  for (const size of SIZES) {
    await render(size).toFile(path.join(ASSETS, `icon-${size}.png`));
    console.log(`  icon-${size}.png`);
  }
  await render(512).toFile(path.join(ASSETS, 'icon.png'));
  console.log('  icon.png');

  // Árbol hicolor que `linux.extraFiles` copia a /usr/share/icons. El nombre
  // debe coincidir con el id de la aplicación; los de marcas anteriores se
  // borran para que el paquete no lleve dos iconos.
  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    const dir = path.join(ASSETS, 'icons', 'hicolor', `${size}x${size}`, 'apps');
    fs.mkdirSync(dir, { recursive: true });
    for (const stale of fs.readdirSync(dir)) {
      if (stale !== `${APP_ID}.png`) fs.unlinkSync(path.join(dir, stale));
    }
    await render(size).toFile(path.join(dir, `${APP_ID}.png`));
  }
  console.log('  assets/icons/hicolor/**');

  await writeIco(path.join(ASSETS, 'icon.ico'), render);
  console.log('  icon.ico');

  if (process.platform === 'darwin') {
    console.log('\n  Para icon.icns ejecuta en macOS: iconutil -c icns assets/icon.iconset');
  } else {
    console.log('\n  ⚠ icon.icns no se regeneró: hace falta iconutil (macOS).');
    console.log('    El archivo anterior sigue en su sitio; sustitúyelo antes de publicar para Mac.');
  }
}

/** Empaqueta varios PNG en un único .ico (formato ICO con entradas PNG). */
async function writeIco(target, render) {
  const images = [];
  for (const size of ICO_SIZES) {
    images.push({ size, data: await render(size).toBuffer() });
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, i) => {
    const entry = i * 16;
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0;
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  fs.writeFileSync(target, Buffer.concat([header, directory, ...images.map((i) => i.data)]));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
