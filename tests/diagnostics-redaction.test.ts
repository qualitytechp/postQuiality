/**
 * El diagnóstico de tienda promete en pantalla que «nunca incluye nombres de
 * clientes, teléfonos, direcciones ni contenido de pedidos».
 *
 * Estas pruebas son esa promesa, escrita de forma que se pueda comprobar. Los
 * casos no son inventados: son la forma que tienen de verdad los mensajes de
 * SQLite, de Node y de Windows cuando algo falla en este POS.
 */
import assert from 'assert';
import {
  redactDiagnosticText,
  redactDiagnosticStack,
  redactRoutePath,
  buildDiagnostic,
  MAX_DIAGNOSTIC_MESSAGE,
} from '../main/services/diagnostics';

let pasadas = 0;
const fallos: string[] = [];

function prueba(nombre: string, fn: () => void): void {
  try {
    fn();
    pasadas++;
    console.log('  ✓ ' + nombre);
  } catch (error) {
    fallos.push(nombre + ': ' + (error as Error).message);
    console.log('  ✗ ' + nombre);
    console.log('      ' + (error as Error).message);
  }
}

/** Nada de esto puede aparecer jamás en un diagnóstico. */
const NUNCA = [
  '3001234567',
  '300 123 4567',
  '+57 300 123 4567',
  'maria.perez@gmail.com',
  '4111111111111111',
];

console.log('\nDiagnóstico de tienda: qué sale y qué no');
console.log('='.repeat(60));

console.log('\n1. Lo que nunca puede salir');

prueba('un teléfono suelto queda tachado', () => {
  const salida = redactDiagnosticText('No se pudo notificar al 3001234567');
  assert.ok(!salida.includes('3001234567'), 'quedó el teléfono: ' + salida);
  assert.ok(salida.includes('<telefono>') || salida.includes('<numero>'), salida);
});

prueba('un teléfono con separadores también', () => {
  const salida = redactDiagnosticText('WhatsApp a +57 300 123 4567 falló');
  assert.ok(!/\d{3}[\s-]?\d{3}/.test(salida), 'quedaron dígitos reconocibles: ' + salida);
});

prueba('un correo queda tachado', () => {
  const salida = redactDiagnosticText('login failed for maria.perez@gmail.com');
  assert.ok(!salida.includes('maria.perez@gmail.com'), salida);
  assert.ok(salida.includes('<correo>'), salida);
});

prueba('un número de tarjeta queda tachado', () => {
  const salida = redactDiagnosticText('payment token 4111111111111111 rejected');
  assert.ok(!salida.includes('4111111111111111'), salida);
});

prueba('el nombre del usuario de Windows no viaja en la ruta', () => {
  const salida = redactDiagnosticText('ENOENT: C:\\Users\\MariaPerez\\AppData\\Roaming\\flo.db');
  assert.ok(!salida.includes('MariaPerez'), salida);
  assert.ok(salida.includes('<usuario>'), salida);
});

prueba('ni en una ruta de macOS o Linux', () => {
  const salida = redactDiagnosticText('EACCES: /Users/mariaperez/Library/flo.db');
  assert.ok(!salida.toLowerCase().includes('mariaperez'), salida);
});

prueba('el valor que rompió una restricción de SQLite no viaja', () => {
  // Así es exactamente como lo reporta SQLite.
  const salida = redactDiagnosticText("UNIQUE constraint failed: customers.phone: '3001234567'");
  assert.ok(!salida.includes('3001234567'), salida);
  // Pero la columna sí, que es lo que le sirve a soporte.
  assert.ok(salida.includes('customers.phone'), 'se perdió la columna: ' + salida);
});

console.log('\n2. Lo que sí tiene que llegar, porque sin eso no hay soporte');

prueba('el código y el tipo del error se conservan', () => {
  const salida = redactDiagnosticText('SQLITE_BUSY: database is locked');
  assert.ok(salida.includes('SQLITE_BUSY'), salida);
  assert.ok(salida.includes('database is locked'), salida);
});

prueba('la traza conserva archivo y línea', () => {
  const stack = 'Error: boom\n    at guardarPedido (C:\\Users\\Maria\\app\\orders.ts:120:11)';
  const salida = redactDiagnosticStack(stack);
  assert.ok(salida.includes('orders.ts:120'), 'se perdió dónde falló: ' + salida);
  assert.ok(!salida.includes('Maria'), 'se filtró el usuario: ' + salida);
});

prueba('la traza se recorta a los primeros marcos', () => {
  const stack = 'Error: boom\n' + Array.from({ length: 60 }, (_, i) => `    at paso${i} (a.ts:${i}:1)`).join('\n');
  const salida = redactDiagnosticStack(stack);
  assert.ok(salida.includes('paso0'), 'se perdió el marco de arriba');
  assert.ok(!salida.includes('paso40'), 'se envió una traza entera');
});

console.log('\n3. La ruta de la petición');

prueba('los identificadores se vuelven :id', () => {
  assert.strictEqual(
    redactRoutePath('/api/customers/9f8e7d6c-1234-4321-abcd-1234567890ab/orders'),
    '/api/customers/:id/orders',
  );
  assert.strictEqual(redactRoutePath('/api/orders/4821/payment'), '/api/orders/:id/payment');
});

prueba('la cadena de consulta se descarta entera', () => {
  // Ahí es donde viaja lo que alguien tecleó en un buscador.
  const salida = redactRoutePath('/api/customers-search?q=Maria+Perez&phone=3001234567');
  assert.ok(!salida.includes('Maria'), salida);
  assert.ok(!salida.includes('3001234567'), salida);
  assert.strictEqual(salida, '/api/customers-search');
});

console.log('\n4. El diagnóstico armado de punta a punta');

prueba('un error real queda listo para enviarse', () => {
  const error = new Error("UNIQUE constraint failed: customers.phone: '3001234567'");
  error.name = 'SqliteError';
  const d = buildDiagnostic('api.error', error, { http_status: 500, route: '/api/customers/77' });

  assert.strictEqual(d.event_code, 'api.error');
  assert.strictEqual(d.severity, 'error');
  assert.strictEqual(d.metadata.error_name, 'SqliteError');
  assert.strictEqual(d.metadata.http_status, 500);
  assert.ok(!JSON.stringify(d).includes('3001234567'), 'se filtró el teléfono: ' + JSON.stringify(d));
});

prueba('nada de la lista prohibida sobrevive, venga por donde venga', () => {
  for (const secreto of NUNCA) {
    const d = buildDiagnostic('x', new Error('fallo con ' + secreto), { nota: 'contacto ' + secreto });
    const completo = JSON.stringify(d);
    assert.ok(!completo.includes(secreto), 'sobrevivió "' + secreto + '" en: ' + completo);
  }
});

prueba('un error sin mensaje no queda vacío', () => {
  const d = buildDiagnostic('x', new Error(''));
  assert.strictEqual(d.message, '(sin mensaje)');
});

prueba('algo que no es un Error tampoco rompe', () => {
  const d = buildDiagnostic('x', 'se cayó y ya');
  assert.strictEqual(d.metadata.error_name, 'string');
  assert.ok(d.message.includes('se cayó'));
});

prueba('el mensaje respeta el tope del canal', () => {
  const d = buildDiagnostic('x', new Error('a'.repeat(5000)));
  assert.ok(d.message.length <= MAX_DIAGNOSTIC_MESSAGE,
    'midió ' + d.message.length + ', tope ' + MAX_DIAGNOSTIC_MESSAGE);
});

console.log('\n5. El reportador, cuando no hay nada detrás');

prueba('reportDiagnosticError nunca lanza, pase lo que pase', () => {
  // Un fallo al reportar no puede tapar el fallo real. Aquí no hay base de
  // datos ni servicio arriba, que es el peor caso posible.
  const { reportDiagnosticError } = require('../main/services/diagnostics');
  assert.doesNotThrow(() => reportDiagnosticError('x', new Error('boom')));
  assert.doesNotThrow(() => reportDiagnosticError('x', null));
  assert.doesNotThrow(() => reportDiagnosticError('x', undefined, { a: 1 }));
});

console.log('\n' + '='.repeat(60));
console.log(`Resultado: ${pasadas} pasadas, ${fallos.length} fallidas`);
if (fallos.length) {
  fallos.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
