// Preloaded only in subprocess tests. A successful default/help invocation proves zero fetches.
globalThis.fetch = async () => { throw new Error("Offline diagnostic fixture forbids all network requests"); };
