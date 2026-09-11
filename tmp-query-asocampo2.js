const Database = require('better-sqlite3');
const db = new Database('C:\\Users\\Administrador\\Documents\\demos\\Asocampo\\flo.db');

console.log('=== TABLES ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(tables.map(r => r.name).join('\n'));

console.log('\n=== PRODUCTS SCHEMA ===');
const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='products'").get();
console.log(schema.sql);

console.log('\n=== CATEGORIAS ===');
const cats = db.prepare('SELECT id, name, is_active FROM categories ORDER BY sort_order, name').all();
cats.forEach(c => console.log(`${c.id} | ${c.name} | active=${c.is_active}`));

console.log('\n=== PRODUCTS (first 5) ===');
const cols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
console.log('Columns:', cols.join(', '));
const products = db.prepare('SELECT * FROM products ORDER BY category_id, sort_order, name LIMIT 5').all();
products.forEach(p => {
  const row = cols.map(c => `${c}=${p[c] !== null ? p[c] : 'NULL'}`).join(' | ');
  console.log(row);
});

console.log('\n=== COUNT PRODUCTS ===');
const count = db.prepare('SELECT COUNT(*) as total FROM products').get();
console.log(`Total: ${count.total}`);

console.log('\n=== COUNT CATEGORIES ===');
const countCats = db.prepare('SELECT COUNT(*) as total FROM categories').get();
console.log(`Total categories: ${countCats.total}`);

db.close();
