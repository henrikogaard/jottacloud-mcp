import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/**
 * Send every request through the proxy a host names in HTTPS_PROXY. Node's
 * built-in fetch ignores that variable unless the runtime is new enough and
 * started with NODE_USE_ENV_PROXY, so a host that confines this server to a
 * proxy cannot rely on it. With no proxy set nothing changes.
 */
export function useProxyFromEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy;
  if (proxy === undefined || proxy === "") return false;
  setGlobalDispatcher(new EnvHttpProxyAgent({ httpsProxy: proxy }));
  return true;
}
