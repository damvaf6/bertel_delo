// Поддельный поставщик: записывает каждый вызов и отвечает по сценарию — успех, отказ, задержка.
// Только для тестов и stage; на prod запрещён настройкой (config.mjs).

export function makeFake(name, handlers) {
  const calls = [];
  let mode = { kind: 'ok' };

  const fake = {
    name,
    calls,
    // mode: { kind: 'ok' } | { kind: 'fail', message } | { kind: 'delay', ms }
    script(next) { mode = next || { kind: 'ok' }; },
    reset() { calls.length = 0; mode = { kind: 'ok' }; },
  };
  for (const [method, impl] of Object.entries(handlers)) {
    fake[method] = async (args) => {
      const call = { method, args, at: new Date().toISOString() };
      calls.push(call);
      if (mode.kind === 'delay') await new Promise((r) => setTimeout(r, mode.ms));
      if (mode.kind === 'fail') { call.failed = true; throw new ProviderError(name, mode.message || 'отказ поставщика'); }
      call.result = await impl(args);
      return call.result;
    };
  }
  return fake;
}

export class ProviderError extends Error {
  constructor(provider, message) { super(message); this.provider = provider; }
}
