import dns from "node:dns";

const installed = Symbol.for("executor.e2e.localhostSubdomainsResolveToLoopback");

const isLocalhostSubdomain = (hostname: string) => /\.localhost\.?$/iu.test(hostname);

const toLoopback = (lookup: (...args: never) => unknown, receiver: object) => {
  const loopback = (hostname: string, ...rest: ReadonlyArray<unknown>): unknown =>
    Reflect.apply(lookup, receiver, [
      isLocalhostSubdomain(hostname) ? "localhost" : hostname,
      ...rest,
    ]);
  for (const key of Object.getOwnPropertySymbols(lookup))
    Reflect.set(loopback, key, Reflect.get(lookup, key));
  Reflect.set(loopback, installed, true);
  return loopback;
};

export const resolveLocalhostSubdomainsToLoopback = () => {
  if (Reflect.get(dns.lookup, installed) === true) return;
  Reflect.set(dns, "lookup", toLoopback(dns.lookup, dns));
  Reflect.set(dns.promises, "lookup", toLoopback(dns.promises.lookup, dns.promises));
};
