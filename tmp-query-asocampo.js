const Database = require('better-sqlite3');
const path = require('path');
const dbPath = 'C:\\Users\\Administrador\\Documents\\demos\\Asocampo\\flo.db';
const db = new Database(dbPath);

console.log('=== CATEGORIAS ===');
const cats = db.prepare('SELECT id, name, is_active FROM categories ORDER BY sort_order, name').all();
cats.forEach(c => console.log(`${c.id} | ${c.name} | active=${c.is_active}`));

console.log('\n=== ADDON GROUPS ===');
const groups = db.prepare('SELECT id, name, is_required, min_selection, max_selection, is_active FROM addon_groups ORDER BY sort_order').all();
if (groups.length === 0) {
  console.log('(sin grupos de adiciones)');
} else {
  groups.forEach(g => console.log(`${g.id} | ${g.name} | required=${g.is_required} | min=${g.min_selection} max=${g.max_selection} | active=${g.is_active}`));
}

console.log('\n=== ADDONS ===');
const addons = db.prepare('SELECT id, addon_group_id, name, price, is_active FROM addons ORDER BY addon_group_id, sort_order').all();
if (addons.length === 0) {
  console.log('(sin adiciones)');
} else {
  addons.forEach(a => console.log(`${a.id} | group=${a.addon_group_id} | ${a.name} | price=${a.price} | active=${a.is_active}`));
}

console.log('\n=== PRODUCTOS ===');
const products = db.prepare('SELECT id, name, price, cost_price, is_active, category_id, tags FROM products ORDER BY category_id, sort_order, name').all();
products.forEach(p => {
  const tagStr = p.tags ? JSON.stringify(p.tags) : '[]';
  console.log(`${p.id} | ${p.name} | price=${p.price} | cost=${p.cost_price ?? '-'} | active=${p.is_active} | cat=${p.category_id} | tags=${tagStr}`);
});
console.log(`\nTotal productos: ${products.length}`);

console.log('\n=== VINCULOS ADDON_GROUP <-> PRODUCTO ===');
const links = db.prepare('SELECT agp.product_id, agp.addon_group_id, p.name FROM addon_group_product agp JOIN products p ON p.id = agp.product_id ORDER BY agp.product_id').all();
if (links.length === 0) {
  console.log('(sin vinculos)');
} else {
  links.forEach(l => console.log(`${l.product_id} | ${l.name} | group=${l.addon_group_id}`));
}

db.close();
