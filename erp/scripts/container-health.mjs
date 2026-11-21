// The image already includes Node: no curl/wget dependency or credentials are needed.
try {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    redirect: "error", signal: AbortSignal.timeout(4000),
  });
  const body = await response.json();
  process.exitCode = response.status === 200 && body?.ok === true && body?.db === true ? 0 : 1;
} catch { process.exitCode = 1; }
