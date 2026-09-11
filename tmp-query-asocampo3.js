const Database = require('better-sqlite3');
const db = new Database('C:\\Users\\Administrador\\Documents\\demos\\Asocampo\\flo.db');

console.log('=== ADDON GROUPS ===');
const groups = db.prepare('SELECT id, name, is_required, min_selection, max_selection, is_active FROM addon_groups ORDER BY name').all();
if (groups.length === 0) { console.log('(sin grupos)'); }
else { groups.forEach(g => console.log(`${g.id} | ${g.name} | req=${g.is_required} | min=${g.min_selection} max=${g.max_selection}`)); }

console.log('\n=== ADDONS ===');
const addons = db.prepare('SELECT id, addon_group_id, name, price, is_active FROM addons ORDER BY name').all();
if (addons.length === 0) { console.log('(sin adiciones)'); }
else { addons.forEach(a => console.log(`${a.id} | group=${a.addon_group_id} | ${a.name} | $${a.price} | active=${a.is_active}`)); }

console.log('\n=== ADDON GROUP LINKS ===');
const links = db.prepare('SELECT agp.product_id, p.name, agp.addon_group_id FROM addon_group_product agp JOIN products p ON p.id = agp.product_id ORDER BY p.name').all();
if (links.length === 0) { console.log('(sin vinculos)'); }
else { links.forEach(l => console.log(`${l.product_id} | ${l.name} | ${l.addon_group_id}`)); }

console.log('\n=== CATEGORIAS ===');
const cats = db.prepare('SELECT id, name FROM categories ORDER BY name').all();
cats.forEach(c => console.log(`${c.id} | ${c.name}`));

console.log('\n=== TODOS LOS PRODUCTOS ===');
const products = db.prepare('SELECT id, category_id, name, price, cost, is_active, tags FROM products ORDER BY name').all();
products.forEach(p => {
  const tagStr = p.tags ? JSON.stringify(p.tags) : '[]';
  console.log(`${p.id} | ${p.name} | $${p.price} | cost=$${p.cost} | active=${p.is_active} | ${p.category_id} | tags=${tagStr}`);
});
console.log(`\nTotal: ${products.length}`);

db.close();
