const Database = require('better-sqlite3');
const db = new Database('C:\\Users\\Administrador\\Documents\\demos\\FloCafe\\flo.db');

console.log('=== TABLAS ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(tables.map(r => r.name).join('\n'));

console.log('\n=== CATEGORIAS ===');
const cats = db.prepare('SELECT id, name, is_active FROM categories ORDER BY name').all();
cats.forEach(r => console.log(`${r.id} | ${r.name} | active=${r.is_active}`));

console.log('\n=== PRODUCTOS ===');
const rows = db.prepare('SELECT id, name, price, is_active, category_id, tags FROM products ORDER BY name').all();
rows.forEach(r => {
  const tagStr = r.tags ? JSON.stringify(r.tags) : '[]';
  console.log(`${r.id} | ${r.name} | price=${r.price} | active=${r.is_active} | cat=${r.category_id} | tags=${tagStr}`);
});

console.log(`\nTotal productos: ${rows.length}`);
db.close();
