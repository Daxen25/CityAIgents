// Test process preload only. Production never imports this file.
// Block all external fetches; redirect the official SDK to a loopback fixture.
const original = globalThis.fetch;
const target = new URL(process.env.AGENT_CITY_TEST_OPENAI_URL);
if (target.hostname !== "127.0.0.1") throw new Error("Offline fixture must be loopback");
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "api.openai.com") {
    if (input instanceof Request) throw new Error("Unexpected SDK transport shape");
    return original(new URL("/openai-fixture", target), init);
  }
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("External HTTP blocked in offline integration test");
  return original(input, init);
};
