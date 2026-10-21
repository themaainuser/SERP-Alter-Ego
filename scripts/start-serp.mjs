// Starts the SERP server on a port that never collides with the Excalidraw MCP server (3000).
//
// Node's process.loadEnvFile() does NOT override variables that are already set, so setting
// PORT here wins over whatever PORT= says in .env. Override with SERP_PORT if you ever need to.
process.env.PORT = process.env.SERP_PORT || '3001';

await import('../dist/server.js');
