import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', `
  const net = require('node:net');
  const server = net.createServer();
  process.on('SIGTERM', () => {});
  server.listen(0, '127.0.0.1', () => process.send({ pid: process.pid, port: server.address().port }));
`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: false });
child.on('message', details => {
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(details) }] } }));
});
setInterval(() => {}, 1000);
