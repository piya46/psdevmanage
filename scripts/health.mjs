const port = { gateway: 3000, identity: 3001, documents: 3002, signing: 3003, audit: 3004 }[
  process.env.SERVICE ?? 'gateway'
];
try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) process.exit(1);
} catch {
  process.exit(1);
}
