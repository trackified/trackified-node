// Mocked fetch: each call shifts the next scripted response and records the request.
export function mockFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: new URL(url), ...init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    const { status = 200, body, headers = {} } = next;
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  fn.calls = calls;
  return fn;
}
