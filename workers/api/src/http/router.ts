/**
 * A small path-pattern router. Patterns use `:name` segments and a trailing
 * `*` wildcard.
 */

export type Handler<C> = (req: Request, ctx: C, params: Record<string, string>) => Promise<Response> | Response;

interface Route<C> {
  method: string;
  segments: string[];
  handler: Handler<C>;
}

export class Router<C> {
  private readonly routes: Route<C>[] = [];

  add(method: string, pattern: string, handler: Handler<C>): this {
    this.routes.push({ method, segments: split(pattern), handler });
    return this;
  }

  get(pattern: string, handler: Handler<C>): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler<C>): this {
    return this.add("POST", pattern, handler);
  }

  put(pattern: string, handler: Handler<C>): this {
    return this.add("PUT", pattern, handler);
  }

  patch(pattern: string, handler: Handler<C>): this {
    return this.add("PATCH", pattern, handler);
  }

  delete(pattern: string, handler: Handler<C>): this {
    return this.add("DELETE", pattern, handler);
  }

  match(method: string, pathname: string): { handler: Handler<C>; params: Record<string, string> } | null {
    const parts = split(pathname);
    let methodMismatch = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      if (route.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { handler: route.handler, params };
    }
    if (methodMismatch) return null;
    return null;
  }
}

function split(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p === "*") {
      params["*"] = parts.slice(i).join("/");
      return params;
    }
    if (i >= parts.length) return null;
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(parts[i]);
    } else if (p !== parts[i]) {
      return null;
    }
  }
  return pattern.length === parts.length ? params : null;
}
