import fs from 'node:fs';
export default async () => { fs.mkdirSync('test-results/screens', { recursive: true }); };
