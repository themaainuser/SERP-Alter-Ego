// Starts the server on port 3001 instead of 3000, for machines where 3000 is already taken by
// another local dev server. scripts/_shot.mjs expects the service on this port.
//
// Node's process.loadEnvFile() does NOT override variables that are already set, so setting
// PORT here wins over whatever PORT= says in .env. Override with SERP_PORT if you need another port.
process.env.PORT = process.env.SERP_PORT || '3001';

await import('../dist/server.js');
