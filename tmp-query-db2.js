const Database = require('better-sqlite3');
const db = new Database('C:\\Users\\Administrador\\Documents\\demos\\FloCafe\\flo.db');

console.log('=== ADDON GROUPS ===');
const groups = db.prepare('SELECT id, name, is_required, min_selection, max_selection, is_active FROM addon_groups ORDER BY sort_order').all();
groups.forEach(g => console.log(`${g.id} | ${g.name} | required=${g.is_required} | min=${g.min_selection} max=${g.max_selection} | active=${g.is_active}`));

console.log('\n=== ADDONS ===');
const addons = db.prepare('SELECT id, addon_group_id, name, price, is_active FROM addons ORDER BY addon_group_id, sort_order').all();
addons.forEach(a => console.log(`${a.id} | group=${a.addon_group_id} | ${a.name} | price=${a.price} | active=${a.is_active}`));

console.log('\n=== ADDON GROUP PRODUCT LINKS ===');
const links = db.prepare('SELECT agp.product_id, agp.addon_group_id, p.name FROM addon_group_product agp JOIN products p ON p.id = agp.product_id ORDER BY agp.product_id').all();
links.forEach(l => console.log(`${l.product_id} | ${l.name} | group=${l.addon_group_id}`));

db.close();
